"""Stage 2b of the bespoke engine: the trained chord-band recogniser (V17c/V17d, ADR-0031).

Reads the **detected** chord band above each staff — Stage 1's own `chordBand` class (`layout.py`
matches one box per staff, `_match_chordband`), the SAME class `packages/synth/src/page-boxes.ts`
labels and V17b's corpus crops from (`packages/synth/src/imaging/band-crops.ts`). Cropping the exact
box the detector found, rather than a staff-relative geometric approximation, is what makes train and
inference crop alike — the same discipline Stage 2a's full-system crop settled at V15c. A staff with no
detected band (no chords on that line, or a miss) simply contributes no tokens.

`chord.onnx` (V17c) is a small character-level CRNN+CTC over the vocabulary
`packages/synth/src/chord-vocab.ts` builds: a chord **separator** class (id `sep`, usually 1) sits
between adjacent chords, so one CTC decode both transcribes *and* segments the band into distinct chord
strings — each token's pixel box comes from the CTC columns its characters occupy, exactly as Stage 2a
derives a note's x from its own column (ADR-0023/Q71).

Non-chord band text (a rehearsal letter, a stray mark) is not this module's problem to classify: like
`band_ocr.py` (the geometric-crop equivalent oemer/heuristic use, having no band detector of their own),
it hands back raw text and a box, and the **V5 grammar corrector** (ADR-0011, TypeScript side,
`mapOmrToScore`) is what turns a string into a legal chord or a flagged `Annotation` (Q56), unchanged
from V13. Python's job here is pixels -> text.
"""

from __future__ import annotations

import json
import os
from typing import Any

# One recognised chord: its text, its axis-aligned box (x1, y1, x2, y2) in the CROP's own coordinates,
# and a confidence in [0, 1] — the same shape `band_ocr.BandLine` gives PaddleOCR's lines.
BandLine = tuple[str, tuple[float, float, float, float], float]

# Must match training (`worker/training/chord_model.py`, `chord_dataset.py`): a band crop resizes to
# this fixed height keeping aspect, width downsampled by 4 through two width-pooling conv blocks.
_MODEL_HEIGHT = 32
# Pixels of slack added around the detected chordBand box, so a tall superscript is never shaved —
# matches the padding V17b's own corpus crop uses (`renderBandCrops`'s default `pad`).
_BAND_PAD = 2


def load_chords(model_dir: str) -> "tuple[Any, list[str], int, int] | None":
    """Load ``chord.onnx`` + its matched vocab from a model dir, or ``None`` if the pair is absent.

    A missing chord pair is not an error: a model dir built for Stage 1+2a only (every pre-V17d
    fixture, and any dev dir that hasn't fetched the chord artifacts) should still recognise notes and
    simply carry no chord band — the same graceful posture `band_ocr.default_band_ocr()` takes for a
    missing PaddleOCR. A *malformed* pair (mismatched class counts) still raises loudly below, the same
    build-time guarantee `stage2a.load_stage2a` gives Stage 2a (ADR-0024).
    """
    onnx_path = os.path.join(model_dir, "chord.onnx")
    vocab_path = os.path.join(model_dir, "chord-vocab.json")
    if not (os.path.isfile(onnx_path) and os.path.isfile(vocab_path)):
        return None

    import onnxruntime as ort

    with open(vocab_path, encoding="utf-8") as fh:
        data = json.load(fh)
    symbols: list[str] = data["symbols"]
    blank = int(data.get("blank", 0))
    sep = int(data.get("sep", 1))
    session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    out_classes = session.get_outputs()[0].shape[-1]
    if isinstance(out_classes, int) and out_classes != len(symbols):
        raise RuntimeError(
            f"chord-vocab.json has {len(symbols)} classes but chord.onnx emits {out_classes}: not a "
            "matched pair (regenerate with `pnpm export:v17c-vocab`)"
        )
    return session, symbols, blank, sep


def _model_input(crop: Any) -> Any:
    """A band crop resized to the model's fixed input height, keeping aspect (grayscale, unnormalised
    — display-worthy on its own). Also the seam the devtools viewer (EPIC-228) uses to show exactly
    what Stage 2b saw."""
    from PIL import Image

    pil = Image.fromarray(crop).convert("L")
    new_w = max(1, round(pil.width * _MODEL_HEIGHT / pil.height))
    return pil.resize((new_w, _MODEL_HEIGHT), Image.BILINEAR)


def _run_columns(session: Any, pil: Any, np: Any) -> "tuple[Any, Any]":
    """Run the CRNN+CTC on an already-prepared band crop, returning ``(best, probs)``: each column's
    argmax class id and the full per-column class-probability matrix (`_collapse_columns` needs both —
    the id to decide keep/drop, the probability to report a chord's confidence)."""
    arr = np.asarray(pil, dtype=np.float32) / 255.0
    arr = (arr - 0.5) / 0.5
    x = arr[np.newaxis, np.newaxis, :, :]
    logits = session.run(None, {session.get_inputs()[0].name: x})[0][0]  # [T, C]
    probs = _softmax(logits, np)
    return probs.argmax(axis=1), probs


def _collapse_columns(best: Any, probs: Any, blank: int) -> list[tuple[int, int, float]]:
    """Greedy CTC collapse (merge repeats, drop blank), keeping each surviving character's column,
    class id and class-probability — shared by the real decode path and the devtools viewer's raw
    character-stream display (both separator and glyph characters survive here; splitting on the
    separator happens afterward, in `chord_ocr_fn`)."""
    kept: list[tuple[int, int, float]] = []
    prev = -1
    for t, cls in enumerate(best.tolist()):
        cls = int(cls)
        if cls != prev and cls != blank:
            kept.append((t, cls, float(probs[t, cls])))
        prev = cls
    return kept


def chord_ocr_fn(session: Any, symbols: list[str], blank: int, sep: int) -> "Any":
    """Build an ``OcrFn``-compatible callable (`band_ocr.OcrFn`): a band crop in, `list[BandLine]` out.

    Returned boxes are in the **crop's own pixel space** (before the model's fixed-height resize),
    matching what `band_ocr.read_band_tokens` expects — it adds the crop's page offset directly, with
    no further scaling, exactly as PaddleOCR's own boxes already are.
    """

    def run(crop: Any) -> "list[BandLine]":
        import numpy as np

        crop_h, crop_w = crop.shape[0], crop.shape[1]
        pil = _model_input(crop)
        best, probs = _run_columns(session, pil, np)
        total_columns = int(best.shape[0])
        kept = _collapse_columns(best, probs, blank)

        # Split the character run into chords on the separator; each run becomes one BandLine, its box
        # spanning the columns its own characters occupied (Stage 2a's column -> x, extended to a range).
        lines: list[BandLine] = []
        current: list[tuple[int, int, float]] = []
        for column, cls, prob in kept:
            if cls == sep:
                _flush(current, symbols, crop_w, crop_h, total_columns, lines)
                current = []
            else:
                current.append((column, cls, prob))
        _flush(current, symbols, crop_w, crop_h, total_columns, lines)
        return lines

    return run


def _flush(
    run: list[tuple[int, int, float]],
    symbols: list[str],
    crop_w: int,
    crop_h: int,
    total_columns: int,
    lines: list[BandLine],
) -> None:
    """Emit one chord's `BandLine` from its kept (column, class, prob) run, if it held any characters."""
    if not run or total_columns <= 0:
        return
    text = "".join(symbols[cls] for _, cls, _ in run)
    first_col, last_col = run[0][0], run[-1][0]
    x1 = first_col * crop_w / total_columns
    x2 = (last_col + 1) * crop_w / total_columns
    confidence = sum(prob for _, _, prob in run) / len(run)
    # y spans the whole crop: chord identity is horizontal position, not vertical, and the crop is
    # already the full band strip — `bandTokensOfSystem` attaches by `group`, not this box's y.
    lines.append((text, (x1, 0.0, x2, float(crop_h)), confidence))


def _softmax(logits: Any, np: Any) -> Any:
    shifted = logits - logits.max(axis=-1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=-1, keepdims=True)


def _band_bounds(box: dict, pad: int, img_w: int, img_h: int) -> "tuple[int, int, int, int]":
    """The padded, clamped ``(left, top, right, bottom)`` pixel crop for one detected chordBand box —
    shared by `read_band_tokens` and the devtools viewer, so both crop the same rectangle."""
    left = max(int(box["x"]) - pad, 0)
    top = max(int(box["y"]) - pad, 0)
    right = min(int(box["x"] + box["w"]) + pad, img_w)
    bottom = min(int(box["y"] + box["h"]) + pad, img_h)
    return left, top, right, bottom


def read_band_tokens(image: Any, staves: list[dict], ocr: Any, pad: int = _BAND_PAD) -> list[dict[str, Any]]:
    """Crop each staff's detected ``chordBand`` box and OCR it, returning tokens in full-image space.

    ``staves`` is the RAW Stage-1 output (`layout.detect_layout`, via `assemble.assemble`'s fifth
    return value) — each entry carries ``chordBand`` (a detector box, or ``None``) attached by
    ``_match_chordband``. ``group`` on each token is the staff's own index (enumeration order), the
    same convention `assemble.py` uses for noteheads/rests/barlines, so `bandTokensOfSystem`
    (`packages/model/src/omr-map.ts`) attaches every token to the right system.
    """
    height, width = image.shape[0], image.shape[1]
    tokens: list[dict[str, Any]] = []
    for group, staff in enumerate(staves):
        box = staff.get("chordBand")
        if box is None:
            continue
        left, top, right, bottom = _band_bounds(box, pad, width, height)
        if bottom - top < 4 or right - left < 4:
            continue
        crop = image[top:bottom, left:right]
        for text, (x1, y1, x2, y2), confidence in ocr(crop):
            clean = text.strip()
            if clean == "":
                continue
            tokens.append(
                {
                    "text": clean,
                    "bbox": [int(left + x1), int(top + y1), int(left + x2), int(top + y2)],
                    "confidence": float(confidence),
                    "group": group,
                }
            )
    return tokens
