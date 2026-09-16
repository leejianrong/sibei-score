"""Stage 2a of the bespoke engine: the trained CRNN+CTC melody recogniser (V15c, ADR-0031).

One staff's full-system crop → an ordered note/rest sequence, with each token's x from the CTC column
it was emitted in and its y synthesised from the decoded pitch on the staff (round-tripping through the
mapper's ``pitchFromGeometry``). Unchanged from V15c except that the staff geometry now comes from the
Stage-1 detector (``layout.py``) rather than the borrowed heuristic finder — the crop reconstruction
and decode are identical, because a staff dict has the same shape either way.
"""

from __future__ import annotations

import json
import os
from typing import Any

# Must match training (`worker/training/model.py`, `dataset.py`): crops resize to this fixed height
# keeping aspect, width downsampled by 4 through two width-pooling conv blocks.
_MODEL_HEIGHT = 128
_BLANK = 0

# Full-system crop reconstruction, in multiples of the detected staff height (V15a proportions,
# settled at V15c so train and inference crop alike): above ≈ 1.6×, below ≈ 0.8× the staff height.
_ABOVE_STAFF_RATIO = 1.6
_BELOW_STAFF_RATIO = 0.8

_LETTERS = ["C", "D", "E", "F", "G", "A", "B"]
_VALUE_TO_LABEL = {1: "WHOLE", 2: "HALF", 4: "QUARTER", 8: "EIGHTH", 16: "SIXTEENTH", 32: "THIRTY_SECOND"}


def load_stage2a(model_dir: str) -> "tuple[Any, list[str]]":
    """Load the Stage-2a onnx session + its matched vocabulary from a model dir (offline, CPU)."""
    import onnxruntime as ort

    with open(os.path.join(model_dir, "vocab.json"), encoding="utf-8") as fh:
        symbols = json.load(fh)["symbols"]
    session = ort.InferenceSession(os.path.join(model_dir, "model.onnx"), providers=["CPUExecutionProvider"])
    out_classes = session.get_outputs()[0].shape[-1]
    if isinstance(out_classes, int) and out_classes != len(symbols):
        raise RuntimeError(
            f"vocab.json has {len(symbols)} classes but model.onnx emits {out_classes}: not a matched "
            "pair (regenerate with `pnpm export:v15c-vocab`)"
        )
    return session, symbols


class _CropBox:
    __slots__ = ("left", "top", "width", "height")

    def __init__(self, left: int, top: int, width: int, height: int) -> None:
        self.left, self.top, self.width, self.height = left, top, width, height


def recognize_staff(
    session: Any,
    symbols: list[str],
    image: Any,
    staff: dict,
    group: int,
    np: Any,
    noteheads: list[dict],
    rests: list[dict],
) -> None:
    """Recognise one staff → append its notes/rests (with coordinates) to the shared lists."""
    img_h, img_w = image.shape[:2]
    box = _crop_box(staff, img_w, img_h)
    seq, total_columns = _decode_crop(session, symbols, image, box, np)
    _emit_objects((seq, total_columns), staff, group, box, noteheads, rests)


def _crop_box(staff: dict, img_w: int, img_h: int) -> _CropBox:
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


def _decode_crop(session: Any, symbols: list[str], image: Any, box: _CropBox, np: Any) -> "tuple[list[tuple[int, str]], int]":
    from PIL import Image

    crop = image[box.top : box.top + box.height, box.left : box.left + box.width]
    pil = Image.fromarray(crop).convert("L")
    new_w = max(1, round(pil.width * _MODEL_HEIGHT / pil.height))
    pil = pil.resize((new_w, _MODEL_HEIGHT), Image.BILINEAR)
    arr = np.asarray(pil, dtype=np.float32) / 255.0
    arr = (arr - 0.5) / 0.5
    x = arr[np.newaxis, np.newaxis, :, :]

    logits = session.run(None, {session.get_inputs()[0].name: x})[0]  # [1, T, C]
    best = logits[0].argmax(axis=1)
    out: list[tuple[int, str]] = []
    prev = -1
    for t, cls in enumerate(best.tolist()):
        if cls != prev and cls != _BLANK:
            out.append((t, symbols[cls]))
        prev = cls
    return out, int(best.shape[0])


def _emit_objects(decoded: "tuple[list[tuple[int, str]], int]", staff: dict, group: int, box: _CropBox, noteheads: list[dict], rests: list[dict]) -> None:
    seq, total_columns = decoded
    if total_columns <= 0:
        return
    unit = staff.get("unit", staff.get("unitSize", 8.0))
    half = unit / 2.0
    y_lower = staff["yLower"]
    y_center = staff["yCenter"]
    half_w = max(unit * 0.6, 1.0)
    half_h = max(unit * 0.6, 1.0)

    for column, symbol in seq:
        x = box.left + (column + 0.5) * box.width / total_columns
        parsed = _parse_symbol(symbol)
        if parsed is None:
            continue
        kind, value, dots, pitch = parsed
        label = _VALUE_TO_LABEL.get(value, "QUARTER")
        has_dot = dots > 0
        if kind == "rest":
            rests.append({"bbox": _bbox(x, y_center, half_w, half_h), "track": 0, "group": group, "hasDot": has_dot, "label": label})
        else:
            step, _alter, octave = pitch  # type: ignore[misc]
            steps = _diatonic(step, octave) - _diatonic("E", 4)
            cy = y_lower - steps * half
            noteheads.append({
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
            })


def _bbox(cx: float, cy: float, half_w: float, half_h: float) -> list[int]:
    x1 = max(0, int(round(cx - half_w)))
    y1 = max(0, int(round(cy - half_h)))
    x2 = int(round(cx + half_w))
    y2 = int(round(cy + half_h))
    return [x1, y1, max(x2, x1 + 1), max(y2, y1 + 1)]


def _diatonic(step: str, octave: int) -> int:
    return octave * 7 + _LETTERS.index(step)


def _parse_symbol(symbol: str) -> "tuple[str, int, int, tuple[str, int, int] | None] | None":
    if symbol.startswith("rest_"):
        value, dots = _parse_duration(symbol[len("rest_") :])
        return None if value is None else ("rest", value, dots, None)
    if symbol.startswith("note_"):
        body = symbol[len("note_") :]
        pitch_part, sep, dur_part = body.partition("_")
        if not sep:
            return None
        value, dots = _parse_duration(dur_part)
        if value is None:
            return None
        pitch = _parse_pitch(pitch_part)
        return None if pitch is None else ("note", value, dots, pitch)
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
    if not text or text[0] not in _LETTERS:
        return None
    step = text[0]
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
