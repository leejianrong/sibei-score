"""The bespoke engine: the fully-trained, staged recogniser (V16, ADR-0031).

The challenger oemer has to beat to earn the default. Two trained models, both small, CPU, low RAM:

- **Stage 1** — the layout detector (``detect.onnx``, V16b), finds the staves + barlines on the page
  (``layout.py``). This replaces the borrowed heuristic OpenCV staff-finder V15c leaned on — the
  real-photo bottleneck.
- **Stage 2a** — the melody recogniser (``model.onnx`` + ``vocab.json``, V15b), reads each staff's
  notes/rests (``stage2a.py``).

``assemble.py`` combines them into the **same** ``OmrDocument`` every engine emits, so ``mapOmrToScore``
and everything downstream are untouched (ADR-0005). The chord band is V17, so ``bandTokens`` is empty.

Offline + CPU-first (ADR-0024, ADR-0025): all three artifacts are baked side by side in
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
VERSION = "0.2.0"  # V16: Stage-1 detector in place of the borrowed staff-finder

# Cache the two onnxruntime sessions + vocab across calls in one worker process, keyed by model dir so
# a test pointing elsewhere is never served a stale model.
_CACHE: dict[str, tuple[Any, Any, list[str]]] = {}


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


def recognize(img_path: str, image_name: str | None = None, ocr: Any = None) -> dict[str, Any]:
    """Run the bespoke pipeline and return an ``OmrDocument`` dict (schema owned by the model).

    ``ocr`` is accepted for signature-compatibility with the other engines' chord-band seam but unused:
    the bespoke chord-band recogniser is V17, so ``bandTokens`` is empty (a bespoke import carries no
    chords, exactly as V11 did before V13's band OCR).
    """
    import cv2
    import numpy as np

    start = time.perf_counter()
    image = cv2.imread(img_path, cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError("could not read the image as a raster")
    height, width = image.shape[:2]

    layout_session, stage2a_session, symbols = _load(_model_dir())
    staves, barlines, noteheads, rests = _assemble.assemble(image, np, layout_session, stage2a_session, symbols)

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
        "staves": staves,
        "zones": [],
        "noteheads": noteheads,
        "noteGroups": [],
        "barlines": barlines,
        "rests": rests,
        "bandTokens": [],
    }
