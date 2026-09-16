"""The bespoke Stage-2a engine: the trained CRNN+CTC melody recogniser (V15c, ADR-0031).

This is the challenger oemer has to beat to earn the default (ADR-0031). It recognises the melody of a
lead sheet with a small model we trained ourselves on synthetic data (`packages/synth` + `worker/
training`), sized for CPU and low RAM — the two axes oemer is unsatisfactory on. It emits the **same**
``OmrDocument`` (``packages/model/src/omr.ts``) every engine does, so ``mapOmrToScore`` and everything
downstream consume it with no engine-specific branch (ADR-0005) — that shared boundary is the point.

**How it works.**

1. *Staves and barlines are found by the heuristic engine's OpenCV staff-finder* (V13c). The Stage-1
   layout detector is V16, not here; for the Stage-2a probe we reuse the geometric finder so this slice
   isolates the *recognition* quality of the trained model on real staff geometry (SLICES V15c). We take
   only its ``staves`` and ``barlines`` and discard its noteheads — those are what the model replaces.

2. *Each staff → one full-system crop → the model → a note/rest token sequence.* The crop is
   reconstructed to match how training cut its crops (a **full-system box**: chord band + staff +
   descenders), because train and inference must crop the same way or the model sees an out-of-
   distribution image (the crop definition was deliberately deferred to V15c so they match, see the V15
   retro). Training cut the box from ``layout``; here we have only the detected staff, so we extend it
   above and below by the fractions of staff height the V15a corpus actually used (measured: above
   ≈ 1.6×, below ≈ 0.8× the staff height — ``_ABOVE_STAFF_RATIO``/``_BELOW_STAFF_RATIO``).

3. *Coordinates come from the CTC column index.* CTC gives a token **sequence** with no per-note x; the
   ``OmrDocument`` requires a pixel bbox per notehead (ADR-0023 / Q71 — stage-3 chord beat-mapping rides
   on it). We recover each token's x from the greedy-decode column it was emitted in: column ``t`` of
   ``T`` maps to ``crop_left + (t + 0.5) · cropWidth / T`` (the width-downsample and the resize cancel,
   leaving this clean form). The vertical position is **not** read from the model — the flat-semantic
   token already carries the pitch, so we place the notehead's bbox at the pixel y that pitch sits at on
   the detected staff (treble geometry), which round-trips exactly through the mapper's
   ``pitchFromGeometry``. So the model supplies the *sequence and horizontal order*; the staff geometry
   supplies the *vertical*.

**Offline and CPU-first** (ADR-0024, ADR-0025): the model is ``model.onnx`` and its matched
``vocab.json`` (the id→symbol table `buildVocabulary()` produced), baked beside each other and read from
``$SIBEI_BESPOKE_MODEL_DIR`` (dev) or the image's baked path. onnxruntime CPU is the same runtime oemer
already loads, so no new heavy dependency; torch is training-only and never imported here.
"""

from __future__ import annotations

import os
import time
from typing import Any

from . import heuristic

SCHEMA_VERSION = 2
ENGINE = "bespoke"
VERSION = "0.1.0"

# Must match training (`worker/training/model.py`, `dataset.py`): crops are resized to this fixed
# height keeping aspect, and the width is downsampled by 4 through two width-pooling conv blocks.
_MODEL_HEIGHT = 128
_WIDTH_DOWNSAMPLE = 4
_BLANK = 0

# One staff space in layout units (`packages/layout` STAFF_SPACE); a staff is four spaces tall.
_STAFF_HEIGHT_SPACES = 4

# Full-system crop reconstruction, in multiples of the detected staff height (top line to bottom line).
# Centred on the V15a corpus's own distribution so the crop the model sees at inference matches the one
# it trained on (measured over 480 systems: aboveStaff mean 1.61×, belowStaff mean 0.80× staff height).
_ABOVE_STAFF_RATIO = 1.6
_BELOW_STAFF_RATIO = 0.8

# Cache the onnxruntime session and vocabulary across calls in one worker process (the server holds one
# engine for its lifetime); keyed by model dir so a test pointing elsewhere is not served a stale model.
_SESSION_CACHE: dict[str, tuple[Any, list[str]]] = {}


def version() -> str:
    return VERSION


# ---------------------------------------------------------------------------
# Model + vocabulary loading (offline, CPU)
# ---------------------------------------------------------------------------


def _model_dir() -> str:
    """Where ``model.onnx`` + ``vocab.json`` live. The image bakes them (ADR-0024); dev points the env
    var at the training output. A clear error beats an onnxruntime "file not found" three frames down."""
    env = os.environ.get("SIBEI_BESPOKE_MODEL_DIR")
    if env:
        return env
    baked = "/opt/sibei/bespoke"
    if os.path.isdir(baked):
        return baked
    raise RuntimeError(
        "bespoke model not found: set $SIBEI_BESPOKE_MODEL_DIR to a directory containing "
        "model.onnx and vocab.json (dev: out/v15b), or bake it at /opt/sibei/bespoke (ADR-0024)"
    )


def _load(model_dir: str) -> tuple[Any, list[str]]:
    cached = _SESSION_CACHE.get(model_dir)
    if cached is not None:
        return cached

    import json

    import onnxruntime as ort

    model_path = os.path.join(model_dir, "model.onnx")
    vocab_path = os.path.join(model_dir, "vocab.json")
    with open(vocab_path, encoding="utf-8") as fh:
        symbols = json.load(fh)["symbols"]

    # CPU is the floor (ADR-0025). Thread pinning is applied by the server's environment
    # (OMP_NUM_THREADS / the eval harness), so speed is measured honestly under a fixed budget
    # (docs/eval.md "Performance metrics"); we do not override it here.
    session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    out_classes = session.get_outputs()[0].shape[-1]
    if isinstance(out_classes, int) and out_classes != len(symbols):
        raise RuntimeError(
            f"vocab.json has {len(symbols)} classes but model.onnx emits {out_classes}: "
            "model and vocabulary are not a matched pair (regenerate with `pnpm export:v15c-vocab`)"
        )
    loaded = (session, symbols)
    _SESSION_CACHE[model_dir] = loaded
    return loaded


# ---------------------------------------------------------------------------
# Recognition
# ---------------------------------------------------------------------------


def recognize(img_path: str, image_name: str | None = None, ocr: Any = None) -> dict[str, Any]:
    """Run the bespoke pipeline and return an ``OmrDocument`` dict (schema owned by the model).

    ``ocr`` is accepted for signature-compatibility with the other engines' chord-band seam but is
    unused here: V15c is Stage-2a (melody) only; the bespoke chord-band recogniser is V17. A bespoke
    import therefore carries no chords, exactly as V11 did before V13's band OCR (``bandTokens`` empty).
    """
    import cv2
    import numpy as np

    start = time.perf_counter()
    image = cv2.imread(img_path, cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError("could not read the image as a raster")
    height, width = image.shape[:2]

    # Stage 1 (borrowed): the heuristic engine's staff + barline finder on the binarised ink.
    _, binary = cv2.threshold(image, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    ink = (binary > 0).astype(np.uint8)
    horizontal = heuristic._horizontal_runs(cv2, ink, width)
    staves = heuristic._detect_staves(np, horizontal, ink, width)
    vertical = heuristic._vertical_runs(cv2, ink, staves)
    barlines = heuristic._detect_barlines(np, vertical, staves)

    session, symbols = _load(_model_dir())

    # Stage 2a: one model pass per staff crop → notes + rests with coordinates.
    noteheads: list[dict[str, Any]] = []
    rests: list[dict[str, Any]] = []
    for group, staff in enumerate(staves):
        crop_box = _crop_box(staff, width, height)
        seq = _decode_crop(session, symbols, image, crop_box, np)
        _emit_objects(seq, staff, group, crop_box, noteheads, rests)

    elapsed = time.perf_counter() - start
    return {
        "schemaVersion": SCHEMA_VERSION,
        "source": {
            "engine": ENGINE,
            "engineVersion": VERSION,
            "imagePath": image_name or os.path.basename(img_path),
            "imageWidth": int(width),
            "imageHeight": int(height),
            "provider": "cpu",
            "wallClockSeconds": round(elapsed, 3),
        },
        "staves": [heuristic._staff_dict(i, s) for i, s in enumerate(staves)],
        "zones": [],
        "noteheads": noteheads,
        "noteGroups": [],
        "barlines": barlines,
        "rests": rests,
        "bandTokens": [],
    }


# ---------------------------------------------------------------------------
# Crop reconstruction — match the training crop from the detected staff
# ---------------------------------------------------------------------------


class _CropBox:
    __slots__ = ("left", "top", "width", "height")

    def __init__(self, left: int, top: int, width: int, height: int) -> None:
        self.left = left
        self.top = top
        self.width = width
        self.height = height


def _crop_box(staff: dict[str, float], img_w: int, img_h: int) -> _CropBox:
    """Reconstruct the full-system crop for a detected staff, matching the V15a training distribution."""
    y_upper = staff["yUpper"]
    y_lower = staff["yLower"]
    staff_h = max(y_lower - y_upper, 1.0)
    top = y_upper - _ABOVE_STAFF_RATIO * staff_h
    bottom = y_lower + _BELOW_STAFF_RATIO * staff_h
    left = staff["xLeft"]
    right = staff["xRight"]

    l = int(max(0, min(round(left), img_w - 1)))
    t = int(max(0, min(round(top), img_h - 1)))
    w = int(max(1, min(round(right - left), img_w - l)))
    h = int(max(1, min(round(bottom - top), img_h - t)))
    return _CropBox(l, t, w, h)


def _decode_crop(
    session: Any, symbols: list[str], image: Any, box: _CropBox, np: Any
) -> "tuple[list[tuple[int, str]], int]":
    """Run the model on one crop and greedy-CTC-decode it to ``(column_index, symbol)`` pairs plus the
    total column count ``T``.

    The column index is the crop-local CTC time step where the token was emitted; the caller turns it
    into a pixel x with ``T``. Pairs are in emission (reading) order.
    """
    from PIL import Image

    crop = image[box.top : box.top + box.height, box.left : box.left + box.width]
    # Resize to the fixed model height, preserving aspect — exactly what the dataset did at training.
    pil = Image.fromarray(crop).convert("L")
    new_w = max(1, round(pil.width * _MODEL_HEIGHT / pil.height))
    pil = pil.resize((new_w, _MODEL_HEIGHT), Image.BILINEAR)
    arr = np.asarray(pil, dtype=np.float32) / 255.0
    arr = (arr - 0.5) / 0.5  # to ~[-1, 1], matching training normalisation
    x = arr[np.newaxis, np.newaxis, :, :]  # [1, 1, H, W]

    logits = session.run(None, {session.get_inputs()[0].name: x})[0]  # [1, T, C]
    best = logits[0].argmax(axis=1)  # [T]

    # CTC collapse: keep a class only when it differs from the previous column (merging repeats), then
    # drop the blank. Record the column each surviving token was emitted in — its x anchor.
    out: list[tuple[int, str]] = []
    prev = -1
    for t, cls in enumerate(best.tolist()):
        if cls != prev and cls != _BLANK:
            out.append((t, symbols[cls]))
        prev = cls
    total_columns = int(best.shape[0])
    return out, total_columns


# ---------------------------------------------------------------------------
# Tokens → OmrDocument objects (notes/rests with coordinates)
# ---------------------------------------------------------------------------

_LETTERS = ["C", "D", "E", "F", "G", "A", "B"]

# model note value -> the mapper's NoteType label (`omr-map.ts` NOTE_VALUE_OF_LABEL, inverted).
_VALUE_TO_LABEL = {1: "WHOLE", 2: "HALF", 4: "QUARTER", 8: "EIGHTH", 16: "SIXTEENTH", 32: "THIRTY_SECOND"}


def _emit_objects(
    decoded: tuple[list[tuple[int, str]], int],
    staff: dict[str, float],
    group: int,
    box: _CropBox,
    noteheads: list[dict[str, Any]],
    rests: list[dict[str, Any]],
) -> None:
    seq, total_columns = decoded
    if total_columns <= 0:
        return
    # The raw staff dict from `_detect_staves` keys line-spacing as "unit" (`_staff_dict` renames it
    # to "unitSize" only in the emitted document); read whichever is present.
    unit = staff.get("unit", staff.get("unitSize", 8.0))
    half = unit / 2.0
    y_lower = staff["yLower"]
    y_center = staff["yCenter"]
    # A notehead's own extent, so the box is a plausible glyph not a point: ~1 space wide/tall.
    half_w = max(unit * 0.6, 1.0)
    half_h = max(unit * 0.6, 1.0)

    for column, symbol in seq:
        # Column t of `total_columns` → pixel x. The width-downsample (÷4) and the aspect-preserving
        # resize cancel, so this reduces to a proportion of the crop width plus the crop's x-offset.
        x = box.left + (column + 0.5) * box.width / total_columns

        parsed = _parse_symbol(symbol)
        if parsed is None:
            continue
        kind, value, dots, pitch = parsed
        label = _VALUE_TO_LABEL.get(value, "QUARTER")
        has_dot = dots > 0

        if kind == "rest":
            rests.append(
                {
                    "bbox": _bbox(x, y_center, half_w, half_h),
                    "track": 0,
                    "group": group,
                    "hasDot": has_dot,
                    "label": label,
                }
            )
        else:
            step, alter, octave = pitch  # type: ignore[misc]
            # Place the head at the pixel y this pitch sits at on the staff, so the mapper's
            # `pitchFromGeometry` reads back the same pitch (E4 on the bottom line, up half a space per step).
            steps = _diatonic(step, octave) - _diatonic("E", 4)
            cy = y_lower - steps * half
            noteheads.append(
                {
                    "id": len(noteheads),
                    "bbox": _bbox(x, cy, half_w, half_h),
                    "track": 0,
                    "group": group,
                    "noteGroupId": None,
                    "staffLinePos": None,
                    "pitch": None,
                    "hasDot": has_dot,
                    "stemUp": None,
                    "invalid": False,
                    "label": label,
                }
            )


def _bbox(cx: float, cy: float, half_w: float, half_h: float) -> list[int]:
    x1 = max(0, int(round(cx - half_w)))
    y1 = max(0, int(round(cy - half_h)))
    x2 = int(round(cx + half_w))
    y2 = int(round(cy + half_h))
    return [x1, y1, max(x2, x1 + 1), max(y2, y1 + 1)]


def _diatonic(step: str, octave: int) -> int:
    return octave * 7 + _LETTERS.index(step)


def _parse_symbol(symbol: str) -> "tuple[str, int, int, tuple[str, int, int] | None] | None":
    """Parse a flat-semantic vocabulary symbol back into (kind, value, dots, pitch).

    Mirrors `packages/synth/src/vocab.ts`:
      note_<Step><accidentals><octave>_<value><d*>   e.g. note_C4_4, note_F#5_4d, note_Bb3_8
      rest_<value><d*>                               e.g. rest_2, rest_4d
    Returns None for the blank or any unrecognised symbol (defensive; the manifest is closed).
    """
    if symbol.startswith("rest_"):
        value, dots = _parse_duration(symbol[len("rest_") :])
        if value is None:
            return None
        return ("rest", value, dots, None)
    if symbol.startswith("note_"):
        body = symbol[len("note_") :]
        pitch_part, sep, dur_part = body.partition("_")
        if not sep:
            return None
        value, dots = _parse_duration(dur_part)
        if value is None:
            return None
        pitch = _parse_pitch(pitch_part)
        if pitch is None:
            return None
        return ("note", value, dots, pitch)
    return None


def _parse_duration(text: str) -> "tuple[int | None, int]":
    dots = 0
    while text.endswith("d"):
        dots += 1
        text = text[:-1]
    try:
        return int(text), dots
    except ValueError:
        return None, dots


def _parse_pitch(text: str) -> "tuple[str, int, int] | None":
    if not text:
        return None
    step = text[0]
    if step not in _LETTERS:
        return None
    i = 1
    alter = 0
    while i < len(text) and text[i] in "#b":
        alter += 1 if text[i] == "#" else -1
        i += 1
    try:
        octave = int(text[i:])
    except ValueError:
        return None
    return (step, alter, octave)
