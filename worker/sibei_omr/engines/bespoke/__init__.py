"""The bespoke engine: the fully-trained, staged recogniser (V16/V17, ADR-0031).

The challenger oemer has to beat to earn the default. Three trained models, all small, CPU, low RAM:

- **Stage 1** — the layout detector (``detect.onnx``, V16b), finds the staves + barlines on the page
  (``layout.py``). This replaces the borrowed heuristic OpenCV staff-finder V15c leaned on — the
  real-photo bottleneck.
- **Stage 2a** — the melody recogniser (``model.onnx`` + ``vocab.json``, V15b), reads each staff's
  notes/rests (``stage2a.py``).
- **Stage 2b** — the chord-band recogniser (``chord.onnx`` + ``chord-vocab.json``, V17c), reads the
  **detected** ``chordBand`` box Stage 1 matched to each staff (``chords.py``) — the same box class
  the training corpus crops from, so train and inference crop alike (unlike `band_ocr.py`'s
  staff-relative approximation, which oemer/heuristic fall back on for lack of their own detector).

``assemble.py`` combines Stage 1 + 2a into the **same** ``OmrDocument`` shape every engine emits, so
``mapOmrToScore`` and everything downstream are untouched (ADR-0005); Stage 2b's ``bandTokens`` are read
here, alongside it, for the same reason.

Offline + CPU-first (ADR-0024, ADR-0025): all five artifacts are baked side by side in
``$SIBEI_BESPOKE_MODEL_DIR`` (dev) or the image's ``/opt/sibei/bespoke`` and read through onnxruntime,
the runtime the worker already loads. torch is training-only and never imported here.
"""

from __future__ import annotations

import os
import time
from typing import Any

from . import assemble as _assemble

SCHEMA_VERSION = 2
ENGINE = "bespoke"
VERSION = "0.3.0"  # V17d: Stage-2b chord band wired in

# Cache the two onnxruntime sessions + vocab across calls in one worker process, keyed by model dir so
# a test pointing elsewhere is never served a stale model.
_CACHE: dict[str, tuple[Any, Any, list[str]]] = {}

# The chord model + vocab, cached the same way — but a missing pair caches as ``None`` (rather than
# retried every call), the same posture `band_ocr.default_band_ocr()` takes for a missing PaddleOCR.
_CHORD_CACHE: dict[str, "tuple[Any, list[str], int, int] | None"] = {}


def version() -> str:
    return VERSION


def _model_dir() -> str:
    env = os.environ.get("SIBEI_BESPOKE_MODEL_DIR")
    if env:
        return env
    baked = "/opt/sibei/bespoke"
    if os.path.isdir(baked):
        return baked
    raise RuntimeError(
        "bespoke model not found: set $SIBEI_BESPOKE_MODEL_DIR to a directory containing model.onnx, "
        "vocab.json (Stage 2a) and detect.onnx (Stage 1), or bake it at /opt/sibei/bespoke (ADR-0024)"
    )


def _load(model_dir: str) -> tuple[Any, Any, list[str]]:
    cached = _CACHE.get(model_dir)
    if cached is not None:
        return cached
    import onnxruntime as ort

    from .stage2a import load_stage2a

    detect_path = os.path.join(model_dir, "detect.onnx")
    if not os.path.isfile(detect_path):
        raise RuntimeError(f"bespoke Stage-1 detector not found: {detect_path} (train with V16b, bake per ADR-0024)")
    layout_session = ort.InferenceSession(detect_path, providers=["CPUExecutionProvider"])
    stage2a_session, symbols = load_stage2a(model_dir)
    loaded = (layout_session, stage2a_session, symbols)
    _CACHE[model_dir] = loaded
    return loaded


def _load_chords(model_dir: str) -> "tuple[Any, list[str], int, int] | None":
    if model_dir in _CHORD_CACHE:
        return _CHORD_CACHE[model_dir]
    from .chords import load_chords

    loaded = load_chords(model_dir)
    _CHORD_CACHE[model_dir] = loaded
    return loaded


def _read_band_tokens(image: Any, raw_staves: list[dict], ocr: Any, model_dir: str) -> list[dict[str, Any]]:
    """Chord-band OCR (Stage 2b, V17d), cropping the exact box Stage 1 detected for each staff.

    ``raw_staves`` is `assemble.assemble`'s fifth return value (not the emitted ``staff_dicts``) — each
    entry carries the ``chordBand`` box `layout.py` matched to it, so this crops what the detector
    found rather than a staff-relative approximation (`chords.py`'s module docstring). ``ocr`` lets a
    test inject a stub, signature-compatible with the other engines' seam; otherwise this loads the
    baked chord model from ``model_dir`` and degrades to an empty band if the pair is not present, so a
    Stage-1+2a-only model dir (every pre-V17d fixture) still recognises notes.
    """
    from .chords import read_band_tokens

    ocr_fn = ocr
    if ocr_fn is None:
        loaded = _load_chords(model_dir)
        if loaded is None:
            return []
        from .chords import chord_ocr_fn

        session, symbols, blank, sep = loaded
        ocr_fn = chord_ocr_fn(session, symbols, blank, sep)

    return read_band_tokens(image, raw_staves, ocr_fn)


def recognize(img_path: str, image_name: str | None = None, ocr: Any = None) -> dict[str, Any]:
    """Run the bespoke pipeline and return an ``OmrDocument`` dict (schema owned by the model).

    ``ocr`` mirrors the other engines' chord-band seam: given (a test stub), it substitutes for the
    trained chord model; otherwise the baked ``chord.onnx`` (Stage 2b, V17c) reads the band above each
    staff into the **same** ``bandTokens`` shape PaddleOCR fills for oemer/heuristic (V13), so
    `mapOmrToScore`'s grammar corrector and stage-3 beat mapping are unchanged (ADR-0011/Q71).
    """
    import cv2
    import numpy as np

    start = time.perf_counter()
    image = cv2.imread(img_path, cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError("could not read the image as a raster")
    height, width = image.shape[:2]

    model_dir = _model_dir()
    layout_session, stage2a_session, symbols = _load(model_dir)
    staff_dicts, barlines, noteheads, rests, raw_staves = _assemble.assemble(
        image, np, layout_session, stage2a_session, symbols
    )
    band_tokens = _read_band_tokens(image, raw_staves, ocr, model_dir)

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
        "staves": staff_dicts,
        "zones": [],
        "noteheads": noteheads,
        "noteGroups": [],
        "barlines": barlines,
        "rests": rests,
        "bandTokens": band_tokens,
    }
