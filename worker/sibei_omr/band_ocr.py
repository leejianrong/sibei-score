"""Chord-band OCR (V13d) — shared by every engine.

ADR-0010 stage 1/2: crop the strip directly above each staff, where a lead sheet's chord symbols
live, and read it with an off-the-shelf text recogniser (PaddleOCR, ADR-0027). This is engine-neutral
— oemer and the heuristic engine both locate staves, so both crop the same band and run the same OCR —
so it lives here, not inside either engine.

The worker emits the text **verbatim**, with each token's box in the **full image's** coordinate
space (the crop offset is added back here), because that is the space the noteheads and barlines are in
and the space stage-3 beat mapping aligns against (Q71). The worker does **not** decide what is a chord:
snapping to a legal chord (the grammar corrector, ADR-0011), or keeping it as a flagged annotation
(Q56), is the model's job in TypeScript (`mapOmrToScore`). Python reads pixels and hands back text.

The OCR itself is an injected seam (``OcrFn``) so this module — and the crop geometry — is testable with
a stub, no PaddlePaddle and no model download. ``paddle_ocr()`` builds the real one, lazily.
"""

from __future__ import annotations

from typing import Any, Callable

# One recognised line: its text, its axis-aligned box (x1, y1, x2, y2) in the CROP's coordinates, and a
# confidence in [0, 1]. The PaddleOCR adapter reduces PaddleOCR's 4-point quad to this box.
BandLine = tuple[str, tuple[float, float, float, float], float]
OcrFn = Callable[[Any], "list[BandLine]"]


class BandStaff:
    """The little a staff needs to expose for band cropping, adapted from each engine's own staff type."""

    __slots__ = ("group", "x_left", "x_right", "y_upper", "unit")

    def __init__(self, group: int, x_left: float, x_right: float, y_upper: float, unit: float) -> None:
        self.group = group
        self.x_left = x_left
        self.x_right = x_right
        self.y_upper = y_upper
        self.unit = unit


# How far above the staff top the chord band reaches, and where it stops, in staff spaces. Chord symbols
# sit roughly 1–3 spaces above the top line; the band is cut a hair above the line so a high notehead or
# the top staff line itself does not bleed into the crop.
_BAND_ABOVE_SPACES = 4.0
_BAND_STOP_SPACES = 0.3


def read_band_tokens(image: Any, staves: list[BandStaff], ocr: OcrFn) -> list[dict[str, Any]]:
    """Crop the band above each staff, OCR it, and return band tokens in full-image coordinates."""
    height = image.shape[0]
    tokens: list[dict[str, Any]] = []
    for staff in staves:
        unit = staff.unit if staff.unit > 0 else 8.0
        top = max(int(staff.y_upper - _BAND_ABOVE_SPACES * unit), 0)
        bottom = min(int(staff.y_upper - _BAND_STOP_SPACES * unit), height)
        left = max(int(staff.x_left), 0)
        right = min(int(staff.x_right) + 1, image.shape[1])
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
                    "group": staff.group,
                }
            )
    return tokens


_default: "OcrFn | None" = None
_default_tried = False


def default_band_ocr() -> "OcrFn | None":
    """The process-wide PaddleOCR seam, built once, or ``None`` when PaddleOCR is unavailable.

    Graceful by design: an engine calls this and, if it gets ``None``, emits an empty band rather than
    failing the whole recognition. That keeps note recognition (and the heuristic engine's whole
    reason to exist — running anywhere) working on a host without PaddlePaddle; the chord band is simply
    absent, exactly as it is for a chart with no chords. The baked image (ADR-0024) always has it.
    """
    global _default, _default_tried
    if _default_tried:
        return _default
    _default_tried = True
    try:
        _default = paddle_ocr()
    except Exception:  # noqa: BLE001 — PaddleOCR/PaddlePaddle absent or failed to load; degrade to no band.
        _default = None
    return _default


def paddle_ocr() -> OcrFn:
    """Build the real PaddleOCR-backed OcrFn (ADR-0027, PaddleOCR 3.x). Imported lazily: PaddlePaddle is
    heavy and only the recognition paths need it, not the seam's tests. The pipeline is created once and
    reused (loading it per crop would be absurd).

    - ``enable_mkldnn=False`` because paddle's oneDNN/PIR path raised ``ConvertPirAttribute2Runtime-
      Attribute`` on a CPU host (a V13d finding); disabling it routes around the bug at a small speed
      cost, and CPU is the floor anyway (ADR-0025).
    - The doc-orientation and unwarping sub-models are off: a band crop is a short horizontal strip,
      already deskewed by the engine, so they add downloads, RAM and latency for nothing.
    - Offline (ADR-0024): the weights are baked into the image and ``PADDLE_PDX_DISABLE_MODEL_SOURCE_
      CHECK`` stops PaddleOCR from probing the network for a newer model at startup. ``fetch_weights.py``
      populates the model cache at build time.
    """
    import os

    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    from paddleocr import PaddleOCR

    engine = PaddleOCR(
        lang="en",
        enable_mkldnn=False,
        use_textline_orientation=False,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
    )

    def run(crop: Any) -> list[BandLine]:
        # PaddleOCR wants a 3-channel image; the heuristic engine works in grayscale, so widen a 2-D crop.
        if getattr(crop, "ndim", 3) == 2:
            import numpy as np

            crop = np.repeat(crop[:, :, None], 3, axis=2)
        results = engine.predict(crop)
        lines: list[BandLine] = []
        for result in results or []:
            texts = result.get("rec_texts") or []
            scores = result.get("rec_scores") or []
            boxes = result.get("rec_boxes")
            boxes = [] if boxes is None else list(boxes)
            for i, text in enumerate(texts):
                box = boxes[i] if i < len(boxes) else None
                if box is None or len(box) < 4:
                    continue
                x1, y1, x2, y2 = (float(box[0]), float(box[1]), float(box[2]), float(box[3]))
                conf = float(scores[i]) if i < len(scores) else 0.0
                lines.append((text, (x1, y1, x2, y2), conf))
        return lines

    return run
