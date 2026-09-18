"""Qualitative viewer for the bespoke OMR engine's stages (EPIC-228).

Dev-only. Never imported by product code, never in CI, never in the shipped worker image —
mirrors the posture of `worker/visualize_detect.py`/`worker/visualize_bespoke.py` and
`tools/runpod` (ADR-0005/0024). It imports `sibei_omr.engines.bespoke` directly via `sys.path`,
not an editable install of the `sibei-omr` package, so it never pulls in oemer/PaddleOCR — see
`devtools/README.md` for setup.

Run it: `make omr-viz` from the repo root (see `devtools/README.md` for the manual steps).

Three top-level tabs, one per pipeline stage:
  - Stage 1 (layout detection, KAN-1505): "final" (what `layout.detect_layout` actually
    clusters + matches) vs "raw" (every detection before clustering).
  - Stage 2a (melody, KAN-1506): pick a staff, then step through ITS sub-stages — the exact
    crop, the model input WITH the decoded notes/rests overlaid on it (a point per token, hover for
    pitch/duration) plus the same data as a table, and the raw per-column CTC stream (run-length,
    blanks kept).
  - Stage 2b (chords, KAN-1506): pick a detected chord band, the same ladder — band crop, model
    input WITH the segmented chords overlaid as boxes (hover for text/confidence) plus a table, and
    the raw collapsed character stream (separator kept).

Stage 2a/2b reuse the exact internal functions the V17e debugging session called directly (not
the HTTP wire format), so what's on screen is what the model actually saw. Out of scope for this
milestone (KAN-1506): whether the V5 grammar corrector would accept a decoded chord as legal or
flag it as an annotation — that's TypeScript-side logic (`packages/music`), and bridging to Node
is its own deferred decision (KAN-1508), same as every other TS-side stage.

Box/point fractions are clamped to [0, 1] before being handed to `ImageOverlay` — a defensive
belt-and-braces even though indah's overlay container now clips (`overflow: hidden` landed upstream
after Milestone A's leejianrong/indah#78 report). Stage 1's boxes stay label-free (a detail table
below carries the true, unclamped coordinates instead); Stage 2a/2b's overlays use indah's newer
`label_mode="hover"` (points always were hover-only) so a busy crop with a dozen notes shows dots/
boxes, not permanent overlapping text — hover one to read it, or read the table underneath for all
of them at once.
"""

from __future__ import annotations

import base64
import io
import os
import sys
from pathlib import Path
from typing import Any

import indah
from indah import (
    Card,
    Checkbox,
    Column,
    DataFrame,
    Image,
    ImageOverlay,
    Number,
    Radio,
    Row,
    Select,
    Signal,
    Slider,
    Tabs,
    Text,
    Upload,
    UploadedFile,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_DIR = REPO_ROOT / "worker"
sys.path.insert(0, str(WORKER_DIR))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402
from PIL import Image as PILImage  # noqa: E402

from sibei_omr.engines.bespoke import chords as chords_mod  # noqa: E402
from sibei_omr.engines.bespoke import layout as bespoke_layout  # noqa: E402
from sibei_omr.engines.bespoke import stage2a as stage2a_mod  # noqa: E402
from sibei_omr.engines.bespoke.detect_config import IN_H, IN_W  # noqa: E402
from sibei_omr.engines.bespoke.detect_decode import decode  # noqa: E402

CLASSES = ["staff", "barline", "chordBand", "title"]
SWATCH = {"staff": "🟦", "barline": "🟥", "chordBand": "🟩", "title": "🟪"}
COLORS = {"staff": "#2f6fe0", "barline": "#e0533a", "chordBand": "#12a150", "title": "#a12fd0"}

MODEL_DIR = os.environ.get("SIBEI_BESPOKE_MODEL_DIR", str(REPO_ROOT / "out" / "bespoke"))
CORPUS_DIR = Path(os.environ.get("OMR_VIZ_CORPUS_DIR", str(REPO_ROOT / "out" / "viz-corpus")))
IMAGE_EXTS = (".png", ".jpg", ".jpeg")

_ACCIDENTAL = {2: "##", 1: "#", 0: "", -1: "b", -2: "bb"}


def _load_detect_session() -> Any:
    path = os.path.join(MODEL_DIR, "detect.onnx")
    if not os.path.isfile(path):
        raise RuntimeError(
            f"Stage-1 detector not found at {path}. Fetch it first: "
            f"`python worker/fetch_bespoke.py --dir {MODEL_DIR}`, or set $SIBEI_BESPOKE_MODEL_DIR."
        )
    return ort.InferenceSession(path, providers=["CPUExecutionProvider"])


def _load_stage2a_session() -> "tuple[Any, list[str]]":
    path = os.path.join(MODEL_DIR, "model.onnx")
    if not os.path.isfile(path):
        raise RuntimeError(
            f"Stage-2a model not found at {path}. Fetch it first: "
            f"`python worker/fetch_bespoke.py --dir {MODEL_DIR}`, or set $SIBEI_BESPOKE_MODEL_DIR."
        )
    return stage2a_mod.load_stage2a(MODEL_DIR)


def _load_chords_bundle() -> "tuple[Any, list[str], int, int] | None":
    """`None` when this model dir has no chord pair baked — Stage 2b then shows a plain notice
    (the same graceful-degrade posture `chords.load_chords` documents for the real pipeline)."""
    return chords_mod.load_chords(MODEL_DIR)


def _list_corpus_images() -> list[str]:
    if not CORPUS_DIR.is_dir():
        return []
    return sorted(p.name for p in CORPUS_DIR.iterdir() if p.suffix.lower() in IMAGE_EXTS)


def _png_data_uri(pil_image: PILImage.Image) -> str:
    """Always re-encode as PNG so the data: URI's mime is honest (a corpus sample may be a
    degraded .jpg; ImageOverlay/Image expect a correctly-labelled source, not sniffed bytes)."""
    buf = io.BytesIO()
    pil_image.convert("RGB").save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _array_to_data_uri(arr: Any) -> str:
    return _png_data_uri(PILImage.fromarray(arr).convert("L"))


def _clamp_box(x: float, y: float, w: float, h: float, img_w: int, img_h: int) -> tuple[float, float, float, float, bool]:
    """Clamp a pixel box to the image bounds; report whether clamping changed anything
    (leejianrong/indah#78 — ImageOverlay has no overflow clipping of its own)."""
    x2, y2 = x + w, y + h
    cx1, cy1 = max(0.0, x), max(0.0, y)
    cx2, cy2 = min(float(img_w), x2), min(float(img_h), y2)
    cw, ch = max(0.0, cx2 - cx1), max(0.0, cy2 - cy1)
    clamped = (cx1, cy1, cw, ch) != (x, y, w, h)
    return cx1, cy1, cw, ch, clamped


def _run_length(classes: list[int], symbols: list[str]) -> list[list[Any]]:
    """Collapse a raw per-column class stream into runs (start, end, classId, symbol) — compact
    enough to eyeball a few hundred columns without losing the blank gaps CTC collapse discards."""
    if not classes:
        return []
    rows: list[list[Any]] = []
    start = 0
    for i in range(1, len(classes) + 1):
        if i == len(classes) or classes[i] != classes[start]:
            cls = classes[start]
            symbol = symbols[cls] if 0 <= cls < len(symbols) else "?"
            rows.append([start, i - 1, cls, symbol])
            start = i
    return rows


def _pitch_str(pitch: "tuple[str, int, int] | None") -> str:
    if pitch is None:
        return ""
    step, alter, octave = pitch
    return f"{step}{_ACCIDENTAL.get(alter, '')}{octave}"


def _clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


def build_session() -> indah.Session:
    detect_session = _load_detect_session()
    stage2a_session, stage2a_symbols = _load_stage2a_session()
    chords_bundle = _load_chords_bundle()
    corpus_files = _list_corpus_images()

    active_source: Signal[str] = Signal("corpus" if corpus_files else "upload")
    picked_file: Signal[str] = Signal(corpus_files[0] if corpus_files else "")
    uploaded_bytes: Signal[bytes | None] = Signal(None)
    uploaded_name: Signal[str] = Signal("")
    threshold: Signal[float] = Signal(0.3)

    active_tab: Signal[int] = Signal(0)
    view_mode: Signal[str] = Signal("final")  # "final" | "raw" (Stage 1 only)
    visible: dict[str, Signal[bool]] = {c: Signal(True) for c in CLASSES}
    stage2a_idx: Signal[float] = Signal(0)
    stage2a_substage: Signal[int] = Signal(0)
    stage2b_idx: Signal[float] = Signal(0)
    stage2b_substage: Signal[int] = Signal(0)

    async def on_upload(file: UploadedFile) -> None:
        uploaded_bytes.set(file.data)
        uploaded_name.set(file.filename)
        active_source.set("upload")

    def current_pil_image() -> PILImage.Image | None:
        if active_source.value == "upload" and uploaded_bytes.value is not None:
            return PILImage.open(io.BytesIO(uploaded_bytes.value)).convert("L")
        if active_source.value == "corpus" and picked_file.value:
            path = CORPUS_DIR / picked_file.value
            if path.is_file():
                return PILImage.open(path).convert("L")
        return None

    def current_array() -> Any:
        img = current_pil_image()
        return np.asarray(img, dtype=np.uint8) if img is not None else None

    def image_src() -> str:
        img = current_pil_image()
        return _png_data_uri(img) if img is not None else ""

    def raw_dets() -> list[dict] | None:
        """decode()'s output, pixel space, cached per (image, threshold) for this render pass."""
        img = current_pil_image()
        if img is None:
            return None
        w, h = img.width, img.height
        arr = np.asarray(img, dtype=np.uint8)
        small = cv2.resize(arr, (IN_W, IN_H), interpolation=cv2.INTER_AREA)
        x = ((small.astype(np.float32) / 255.0 - 0.5) / 0.5)[np.newaxis, np.newaxis, :, :]
        out = detect_session.run(None, {detect_session.get_inputs()[0].name: x})[0][0]
        return decode(out, orig_w=w, orig_h=h, thresh=threshold.value)

    def layout_result() -> "tuple[list[dict], list[dict]]":
        """The RAW Stage-1 staves (carrying `chordBand`) + barlines — shared by Stage 1's "final"
        view and Stage 2a/2b's staff/band pickers, so switching tabs never re-runs the detector."""
        arr = current_array()
        if arr is None:
            return [], []
        return bespoke_layout.detect_layout(arr, np, detect_session)

    # Memoized so the ~0.4-0.7s Stage-1 inference runs once per (image) render pass, shared by
    # every tab, not once per tab that happens to need staves.
    layout_computed = indah.computed(layout_result)

    def final_objects() -> list[dict]:
        """The staves/barlines/chordBand the real pipeline actually clusters+matches (pixel space,
        each carrying its own `cls`/`score` the way a raw det does, so downstream code is shared)."""
        staves, barlines = layout_computed.value
        objs: list[dict] = []
        for s in staves:
            objs.append(
                {"cls": 0, "score": 1.0, "x": s["xLeft"], "y": s["yUpper"], "w": s["xRight"] - s["xLeft"], "h": s["yLower"] - s["yUpper"]}
            )
            band = s.get("chordBand")
            if band is not None:
                objs.append({"cls": 2, "score": band["score"], "x": band["x"], "y": band["y"], "w": band["w"], "h": band["h"]})
        for b in barlines:
            x1, y1, x2, y2 = b["bbox"]
            objs.append({"cls": 1, "score": 1.0, "x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1})
        return objs

    def current_objects() -> list[dict]:
        return raw_dets() or [] if view_mode.value == "raw" else final_objects()

    detections_computed = indah.computed(current_objects)

    def rows() -> tuple[list[dict], list[dict]]:
        """(overlay boxes [clamped, filtered], table rows [true coords, unclamped])."""
        img = current_pil_image()
        if img is None:
            return [], []
        w, h = img.width, img.height
        boxes: list[dict] = []
        table: list[dict] = []
        for d in detections_computed.value:
            cls = CLASSES[d["cls"]]
            cx, cy, cw, ch, clamped = _clamp_box(d["x"], d["y"], d["w"], d["h"], w, h)
            table.append(
                {
                    "class": cls,
                    "score": round(d["score"], 2),
                    "x": round(d["x"]),
                    "y": round(d["y"]),
                    "w": round(d["w"]),
                    "h": round(d["h"]),
                    "clamped": "yes" if clamped else "",
                }
            )
            if not visible[cls].value:
                continue
            if cw <= 0 or ch <= 0:
                continue
            boxes.append({"x": cx / w, "y": cy / h, "w": cw / w, "h": ch / h, "color": COLORS[cls]})
        return boxes, table

    rows_computed = indah.computed(rows)

    def overlay_boxes() -> list[dict]:
        return rows_computed.value[0]

    def table_data() -> dict:
        table = [r for r in rows_computed.value[1] if visible[r["class"]].value]
        return {"columns": ["class", "score", "x", "y", "w", "h", "clamped"], "rows": [list(r.values()) for r in table]}

    def counts_text() -> str:
        img = current_pil_image()
        if img is None:
            return "_No image selected — pick a corpus sample or upload a photo._"
        table = rows_computed.value[1]
        by_class: dict[str, int] = {c: 0 for c in CLASSES}
        clamped_n = 0
        for r in table:
            by_class[r["class"]] = by_class.get(r["class"], 0) + 1
            if r["clamped"]:
                clamped_n += 1
        parts = ", ".join(f"{SWATCH[c]} **{c}**: {n}" for c, n in by_class.items())
        clamp_note = f" — **{clamped_n}** box(es) extended past the page edge (clamped to fit; see the table for true coordinates)" if clamped_n else ""
        return f"{img.width}×{img.height}px — {parts}{clamp_note}"

    def corpus_hint() -> str:
        if corpus_files:
            return ""
        return (
            f"_No corpus images at `{CORPUS_DIR}`. Generate some from the repo root:_ "
            "`pnpm eval --dump-corpus out/viz-corpus --seeds 6 --bars 16`"
        )

    # ---- Stage 2a: melody recogniser -----------------------------------------------------------

    def stage2a_data() -> "dict | None":
        """Everything Stage 2a needs for the currently selected staff, computed once: the exact
        crop box, the resized model input, the raw per-column CTC stream, its collapse, and the
        emitted note/rest objects — the same functions (`_crop_box`/`_model_input`/`_run_columns`/
        `_ctc_collapse`/`_emit_objects`) `recognize_staff` calls in the real pipeline, so what's on
        screen (and overlaid on the model input) is what the model actually saw and produced."""
        arr = current_array()
        staves, _ = layout_computed.value
        if arr is None or not staves:
            return None
        idx = max(0, min(int(stage2a_idx.value), len(staves) - 1))
        staff = staves[idx]
        img_h, img_w = arr.shape[:2]
        box = stage2a_mod._crop_box(staff, img_w, img_h)
        crop = arr[box.top : box.top + box.height, box.left : box.left + box.width]
        model_input = stage2a_mod._model_input(arr, box, np)
        raw_classes = stage2a_mod._run_columns(stage2a_session, model_input, np)
        seq = stage2a_mod._ctc_collapse(raw_classes, stage2a_symbols, stage2a_mod._BLANK)
        noteheads: list[dict] = []
        rests: list[dict] = []
        stage2a_mod._emit_objects((seq, len(raw_classes)), staff, idx, box, noteheads, rests)
        return {
            "index": idx,
            "count": len(staves),
            "box": box,
            "crop": crop,
            "model_input": model_input,
            "raw_classes": raw_classes,
            "seq": seq,
            "total_columns": len(raw_classes),
            "noteheads": noteheads,
            "rests": rests,
        }

    stage2a_computed = indah.computed(stage2a_data)

    def stage2a_caption() -> str:
        staves, _ = layout_computed.value
        if not staves:
            return "_No staff detected in this image._"
        d = stage2a_computed.value
        if d is None:
            return ""
        mi = d["model_input"]
        return (
            f"Staff **{d['index'] + 1} of {d['count']}** — crop {d['box'].width}×{d['box'].height}px, "
            f"model input {mi.width}×{mi.height}px, {d['total_columns']} CTC columns, "
            f"**{len(d['seq'])}** decoded token(s)."
        )

    def stage2a_crop_src() -> str:
        d = stage2a_computed.value
        return _array_to_data_uri(d["crop"]) if d else ""

    def stage2a_model_input_src() -> str:
        d = stage2a_computed.value
        return _png_data_uri(d["model_input"]) if d else ""

    def stage2a_overlay_points() -> list[dict]:
        """One point per decoded note/rest, positioned on the model input image — fractions are
        size-independent (the model input is the crop uniformly rescaled, same aspect), so a
        column's fraction-of-crop-width IS its fraction-of-model-input-width, no separate mapping
        needed. Pitch/duration ride as a hover label (indah's `points` are hover-only by design)."""
        d = stage2a_computed.value
        if not d or not d["box"].width or not d["box"].height:
            return []
        box = d["box"]
        note_iter = iter(d["noteheads"])
        rest_iter = iter(d["rests"])
        points: list[dict] = []
        for _column, symbol in d["seq"]:
            parsed = stage2a_mod._parse_symbol(symbol)
            if parsed is None:
                continue
            kind, value, dots, pitch = parsed
            obj = next(note_iter, None) if kind == "note" else next(rest_iter, None)
            if obj is None:
                continue
            cx = (obj["bbox"][0] + obj["bbox"][2]) / 2
            cy = (obj["bbox"][1] + obj["bbox"][3]) / 2
            duration = stage2a_mod._VALUE_TO_LABEL.get(value, str(value))
            dot = "." if dots else ""
            label = f"{_pitch_str(pitch)} {duration}{dot}" if kind == "note" else f"rest {duration}{dot}"
            points.append(
                {
                    "x": _clamp01((cx - box.left) / box.width),
                    "y": _clamp01((cy - box.top) / box.height),
                    "label": label,
                    "color": "#2f6fe0" if kind == "note" else "#e0533a",
                }
            )
        return points

    def stage2a_raw_table() -> dict:
        d = stage2a_computed.value
        rows = _run_length(d["raw_classes"], stage2a_symbols) if d else []
        return {"columns": ["start", "end", "classId", "symbol"], "rows": rows}

    def stage2a_decoded_table() -> dict:
        d = stage2a_computed.value
        rows: list[list[Any]] = []
        if d:
            box, total_columns = d["box"], d["total_columns"]
            for order, (column, symbol) in enumerate(d["seq"]):
                x = box.left + (column + 0.5) * box.width / total_columns if total_columns else box.left
                parsed = stage2a_mod._parse_symbol(symbol)
                if parsed is None:
                    rows.append([order, "?", symbol, "", "", round(x)])
                    continue
                kind, value, dots, pitch = parsed
                duration = stage2a_mod._VALUE_TO_LABEL.get(value, str(value))
                rows.append([order, kind, _pitch_str(pitch), duration, "yes" if dots else "", round(x)])
        return {"columns": ["order", "kind", "pitch", "duration", "dotted", "x"], "rows": rows}

    # ---- Stage 2b: chord band recogniser -------------------------------------------------------

    def stage2b_band_indices() -> list[int]:
        staves, _ = layout_computed.value
        return [i for i, s in enumerate(staves) if s.get("chordBand") is not None]

    def stage2b_data() -> "dict | None":
        """Everything Stage 2b needs for the currently selected chord band, computed once: the
        exact detected-box crop (post-V17e-fix window), the resized model input, and the raw
        collapsed character stream (separator kept) — the same functions `chord_ocr_fn` calls in
        the real pipeline."""
        if chords_bundle is None:
            return None
        session, symbols, blank, sep = chords_bundle
        arr = current_array()
        band_indices = stage2b_band_indices()
        if arr is None or not band_indices:
            return None
        pick = max(0, min(int(stage2b_idx.value), len(band_indices) - 1))
        staves, _ = layout_computed.value
        staff_index = band_indices[pick]
        staff = staves[staff_index]
        img_h, img_w = arr.shape[:2]
        left, top, right, bottom = chords_mod._band_bounds(staff["chordBand"], chords_mod._BAND_PAD, img_w, img_h)
        crop = arr[top:bottom, left:right]
        model_input = chords_mod._model_input(crop)
        best, probs = chords_mod._run_columns(session, model_input, np)
        kept = chords_mod._collapse_columns(best, probs, blank)
        return {
            "pick": pick,
            "count": len(band_indices),
            "staff_index": staff_index,
            "crop": crop,
            "crop_w": crop.shape[1],
            "crop_h": crop.shape[0],
            "model_input": model_input,
            "kept": kept,
            "total_columns": int(best.shape[0]),
            "symbols": symbols,
            "sep": sep,
        }

    stage2b_computed = indah.computed(stage2b_data)

    def stage2b_caption() -> str:
        if chords_bundle is None:
            return "_No chord model baked into this model dir — Stage 2b is unavailable (see `devtools/README.md`)._"
        if not stage2b_band_indices():
            return "_No chord band detected in this image._"
        d = stage2b_computed.value
        if d is None:
            return ""
        mi = d["model_input"]
        return (
            f"Band **{d['pick'] + 1} of {d['count']}** (staff {d['staff_index'] + 1}) — crop "
            f"{d['crop_w']}×{d['crop_h']}px, model input {mi.width}×{mi.height}px, "
            f"{d['total_columns']} CTC columns."
        )

    def stage2b_crop_src() -> str:
        d = stage2b_computed.value
        return _array_to_data_uri(d["crop"]) if d else ""

    def stage2b_model_input_src() -> str:
        d = stage2b_computed.value
        return _png_data_uri(d["model_input"]) if d else ""

    def stage2b_raw_table() -> dict:
        d = stage2b_computed.value
        rows: list[list[Any]] = []
        if d:
            for column, cls, prob in d["kept"]:
                char = "<sep>" if cls == d["sep"] else d["symbols"][cls]
                rows.append([column, char, round(prob, 3)])
        return {"columns": ["column", "char", "confidence"], "rows": rows}

    def stage2b_lines() -> list:
        """The segmented chords — text, box (crop pixel space), confidence — split on the
        separator exactly as `chord_ocr_fn` does. Shared by the table and the overlay, computed once."""
        d = stage2b_computed.value
        if not d:
            return []
        lines: list = []
        current: list = []
        for column, cls, prob in d["kept"]:
            if cls == d["sep"]:
                chords_mod._flush(current, d["symbols"], d["crop_w"], d["crop_h"], d["total_columns"], lines)
                current = []
            else:
                current.append((column, cls, prob))
        chords_mod._flush(current, d["symbols"], d["crop_w"], d["crop_h"], d["total_columns"], lines)
        return lines

    stage2b_lines_computed = indah.computed(stage2b_lines)

    def stage2b_chords_table() -> dict:
        rows = [
            [text, round(confidence, 3), round(x1), round(x2)]
            for text, (x1, _y1, x2, _y2), confidence in stage2b_lines_computed.value
        ]
        return {"columns": ["text", "confidence", "x1", "x2"], "rows": rows}

    def stage2b_overlay_boxes() -> list[dict]:
        """One box per segmented chord, positioned on the model input image — same size-independent
        fraction argument as Stage 2a's points (`_flush`'s box is already in the crop's own pixel
        space, and the model input is that crop uniformly rescaled). `label_mode="hover"` shows the
        chord text + confidence on hover rather than as permanent overlapping text."""
        d = stage2b_computed.value
        if not d or not d["crop_w"] or not d["crop_h"]:
            return []
        boxes: list[dict] = []
        for text, (x1, y1, x2, y2), confidence in stage2b_lines_computed.value:
            boxes.append(
                {
                    "x": _clamp01(x1 / d["crop_w"]),
                    "y": _clamp01(y1 / d["crop_h"]),
                    "w": _clamp01((x2 - x1) / d["crop_w"]),
                    "h": _clamp01((y2 - y1) / d["crop_h"]),
                    "label": text,
                    "score": confidence,
                    "color": "#12a150",
                }
            )
        return boxes

    # ---- Layout ---------------------------------------------------------------------------------

    legend = Row(
        children=[Checkbox(visible[c], label=f"{SWATCH[c]} {c}") for c in CLASSES],
        gap="1.5rem",
    )

    inputs = Card(
        title="Input",
        children=[
            Radio(active_source, options=["corpus", "upload"], label="Source"),
            Select(picked_file, options=corpus_files or [""], label="Corpus image"),
            Text(corpus_hint, markdown=True),
            Upload(on_upload, accept="image/*", label="Upload a real photo"),
            Text(lambda: f"Active: {uploaded_name.value}" if active_source.value == "upload" and uploaded_name.value else ""),
        ],
    )

    stage1_panel = Card(
        title="Stage 1 — layout detection",
        children=[
            Row(
                children=[
                    Slider(threshold, min=0.05, max=0.9, step=0.01, label="Stage-1 score threshold (raw view only)"),
                    Radio(view_mode, options=["final", "raw"], label="View"),
                ]
            ),
            Text(
                lambda: (
                    "**Final**: the staves/barlines/chordBand the pipeline actually uses, after clustering + matching."
                    if view_mode.value == "final"
                    else "**Raw**: every individual detection before clustering — noisier by design (KAN-1510/1511)."
                ),
                markdown=True,
            ),
            legend,
            ImageOverlay(image_src, boxes=overlay_boxes, alt="page with Stage-1 detections"),
            Text(counts_text, markdown=True),
            DataFrame(table_data, label="Detections (true, unclamped coordinates)"),
        ],
    )

    stage2a_panel = Card(
        title="Stage 2a — melody recogniser",
        children=[
            Number(stage2a_idx, min=0, max=63, step=1, label="Staff #"),
            Text(stage2a_caption, markdown=True),
            Tabs(
                labels=["Crop", "Model input + predictions", "Raw columns"],
                active=stage2a_substage,
                children=[
                    Image(stage2a_crop_src, alt="Stage-2a full-system crop"),
                    Column(
                        children=[
                            ImageOverlay(
                                stage2a_model_input_src,
                                points=stage2a_overlay_points,
                                alt="Stage-2a model input with decoded notes/rests overlaid",
                            ),
                            Text("Hover a point for its pitch/duration — 🔵 note, 🔴 rest.", markdown=True),
                            DataFrame(stage2a_decoded_table, label="Decoded notes/rests"),
                        ]
                    ),
                    DataFrame(stage2a_raw_table, label="Raw CTC columns (run-length, blanks kept)"),
                ],
            ),
        ],
    )

    stage2b_panel = Card(
        title="Stage 2b — chord band recogniser",
        children=[
            Number(stage2b_idx, min=0, max=63, step=1, label="Band #"),
            Text(stage2b_caption, markdown=True),
            Tabs(
                labels=["Band crop", "Model input + predictions", "Raw characters"],
                active=stage2b_substage,
                children=[
                    Image(stage2b_crop_src, alt="Stage-2b band crop"),
                    Column(
                        children=[
                            ImageOverlay(
                                stage2b_model_input_src,
                                boxes=stage2b_overlay_boxes,
                                label_mode="hover",
                                alt="Stage-2b model input with segmented chords overlaid",
                            ),
                            Text("Hover a box for its chord text + confidence.", markdown=True),
                            DataFrame(stage2b_chords_table, label="Segmented chords"),
                        ]
                    ),
                    DataFrame(stage2b_raw_table, label="Raw CTC characters (collapsed, separator kept)"),
                ],
            ),
        ],
    )

    page = Column(
        children=[
            Text(
                "# OMR pipeline viewer\n\n"
                "Dev-only qualitative check for the bespoke engine (EPIC-228). "
                "See `docs/omr-pipeline.md` for the pipeline these stages belong to.",
                markdown=True,
            ),
            inputs,
            Tabs(
                labels=["Stage 1 — layout", "Stage 2a — melody", "Stage 2b — chords"],
                active=active_tab,
                children=[stage1_panel, stage2a_panel, stage2b_panel],
            ),
        ]
    )

    return indah.Session(page)


app = indah.create_app(session_factory=build_session)

if __name__ == "__main__":
    indah.launch(app)
