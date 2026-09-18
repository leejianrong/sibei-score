"""Qualitative viewer for the bespoke OMR engine's Stage 1 layout detector (EPIC-228,
Milestone A / KAN-1505).

Dev-only. Never imported by product code, never in CI, never in the shipped worker image —
mirrors the posture of `worker/visualize_detect.py` and `tools/runpod` (ADR-0005/0024). It
imports `sibei_omr.engines.bespoke` directly via `sys.path`, not an editable install of the
`sibei-omr` package, so it never pulls in oemer/PaddleOCR — see `devtools/README.md` for setup.

Run it: `make omr-viz` from the repo root (see `devtools/README.md` for the manual steps).

Two views, toggled in the Input panel:
  - "final" (default): the staves/barlines `layout.detect_layout` actually clusters, and the
    chordBand each staff actually gets matched to — the geometry the real pipeline uses.
  - "raw": every individual detection `decode()` returns before clustering/matching, exactly
    as the model emits it. Noisier — this is the view that surfaced KAN-1510/KAN-1511 (Stage-1
    box-regression imprecision, and duplicate detections along a wide object's heatmap ridge).

Box fractions are clamped to the image bounds before being handed to `ImageOverlay`, since
indah's overlay has no `overflow: hidden` (leejianrong/indah#78) — an out-of-range box would
otherwise bleed onto the surrounding page. The *true*, unclamped pixel box is still shown in
the detail table below, so nothing is lost, just contained.
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
    ImageOverlay,
    Radio,
    Row,
    Select,
    Signal,
    Slider,
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

from sibei_omr.engines.bespoke import layout as bespoke_layout  # noqa: E402
from sibei_omr.engines.bespoke.detect_config import IN_H, IN_W  # noqa: E402
from sibei_omr.engines.bespoke.detect_decode import decode  # noqa: E402

CLASSES = ["staff", "barline", "chordBand", "title"]
SWATCH = {"staff": "🟦", "barline": "🟥", "chordBand": "🟩", "title": "🟪"}
COLORS = {"staff": "#2f6fe0", "barline": "#e0533a", "chordBand": "#12a150", "title": "#a12fd0"}

MODEL_DIR = os.environ.get("SIBEI_BESPOKE_MODEL_DIR", str(REPO_ROOT / "out" / "bespoke"))
CORPUS_DIR = Path(os.environ.get("OMR_VIZ_CORPUS_DIR", str(REPO_ROOT / "out" / "viz-corpus")))
IMAGE_EXTS = (".png", ".jpg", ".jpeg")


def _load_session() -> Any:
    path = os.path.join(MODEL_DIR, "detect.onnx")
    if not os.path.isfile(path):
        raise RuntimeError(
            f"Stage-1 detector not found at {path}. Fetch it first: "
            f"`python worker/fetch_bespoke.py --dir {MODEL_DIR}`, or set $SIBEI_BESPOKE_MODEL_DIR."
        )
    return ort.InferenceSession(path, providers=["CPUExecutionProvider"])


def _list_corpus_images() -> list[str]:
    if not CORPUS_DIR.is_dir():
        return []
    return sorted(p.name for p in CORPUS_DIR.iterdir() if p.suffix.lower() in IMAGE_EXTS)


def _png_data_uri(pil_image: PILImage.Image) -> str:
    """Always re-encode as PNG so the data: URI's mime is honest (a corpus sample may be a
    degraded .jpg; ImageOverlay expects a correctly-labelled source, not sniffed bytes)."""
    buf = io.BytesIO()
    pil_image.convert("RGB").save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _clamp_box(x: float, y: float, w: float, h: float, img_w: int, img_h: int) -> tuple[float, float, float, float, bool]:
    """Clamp a pixel box to the image bounds; report whether clamping changed anything
    (leejianrong/indah#78 — ImageOverlay has no overflow clipping of its own)."""
    x2, y2 = x + w, y + h
    cx1, cy1 = max(0.0, x), max(0.0, y)
    cx2, cy2 = min(float(img_w), x2), min(float(img_h), y2)
    cw, ch = max(0.0, cx2 - cx1), max(0.0, cy2 - cy1)
    clamped = (cx1, cy1, cw, ch) != (x, y, w, h)
    return cx1, cy1, cw, ch, clamped


def build_session() -> indah.Session:
    session = _load_session()
    corpus_files = _list_corpus_images()

    active_source: Signal[str] = Signal("corpus" if corpus_files else "upload")
    picked_file: Signal[str] = Signal(corpus_files[0] if corpus_files else "")
    uploaded_bytes: Signal[bytes | None] = Signal(None)
    uploaded_name: Signal[str] = Signal("")
    threshold: Signal[float] = Signal(0.3)
    view_mode: Signal[str] = Signal("final")  # "final" | "raw"
    visible: dict[str, Signal[bool]] = {c: Signal(True) for c in CLASSES}

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
        out = session.run(None, {session.get_inputs()[0].name: x})[0][0]
        return decode(out, orig_w=w, orig_h=h, thresh=threshold.value)

    def final_objects() -> list[dict]:
        """The staves/barlines/chordBand the real pipeline actually clusters+matches (pixel space,
        each carrying its own `cls`/`score` the way a raw det does, so downstream code is shared)."""
        img = current_pil_image()
        if img is None:
            return []
        arr = np.asarray(img, dtype=np.uint8)
        staves, barlines = bespoke_layout.detect_layout(arr, np, session)
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

    # The expensive part (onnxruntime inference) memoized on its own, so toggling a legend
    # checkbox below — which changes nothing about the detections themselves — never re-runs
    # inference; only `rows()`'s cheap clamp/filter pass reruns for that.
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

    # `rows()` runs the actual onnxruntime inference — memoize it (indah.computed) so the three
    # reactive props below that need it (overlay, table, counts) share one inference call per
    # signal change instead of tripling the ~0.4-0.7s Stage-1 cost on every interaction.
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
            Row(
                children=[
                    Slider(threshold, min=0.05, max=0.9, step=0.01, label="Stage-1 score threshold (raw view only)"),
                    Radio(view_mode, options=["final", "raw"], label="View"),
                ]
            ),
        ],
    )

    output = Card(
        title="Stage 1 — layout detection",
        children=[
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

    page = Column(
        children=[
            Text(
                "# OMR pipeline viewer — Stage 1 (layout detection)\n\n"
                "Dev-only qualitative check for the bespoke engine (EPIC-228). "
                "See `docs/omr-pipeline.md` for the pipeline this stage belongs to.",
                markdown=True,
            ),
            inputs,
            output,
        ]
    )

    return indah.Session(page)


app = indah.create_app(session_factory=build_session)

if __name__ == "__main__":
    indah.launch(app)
