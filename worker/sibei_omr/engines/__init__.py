"""The engine-selection seam (V13c).

The worker recognises with one of several engines, and every engine emits the **same** OmrDocument
(``packages/model/src/omr.ts``) so nothing downstream — the ``WorkerClient`` port, the job runner,
``mapOmrToScore``, both surfaces — ever learns which one ran (ADR-0005). This is v0.3's engine-seam
(SLICES V15, ADR-0031) pulled forward, because it is what lets a second, dependency-light engine run
the whole import flow on a small host where oemer's ~7 GB model is OOM-killed (V12).

Three engines today:

- ``oemer`` — the default, and the only one with weights baked into the image (ADR-0024). Its
  implementation is the V9/V10 in-process pipeline in ``sibei_omr.recognize``; this seam just adapts it.
- ``heuristic`` — a dependency-light (OpenCV only, no ML weights, low RAM) engine, added at V13c. It is
  **dev/test scaffolding and the seed of the bespoke direction** (ADR-0031), NOT the trained bespoke
  model, and it earns **no** default swap. Its accuracy is poor on real photos by design; the point is
  that the whole photo → draft → PDF flow, and ``make eval``, run end to end without oemer's RAM.
- ``bespoke`` — the trained Stage-2a melody recogniser (V15c, ADR-0031): a small CRNN+CTC we trained on
  synthetic data (`packages/synth` + `worker/training`), read on CPU via onnxruntime, sized for low RAM.
  It reuses the heuristic engine's staff-finder for crops (the Stage-1 layout detector is V16) and
  replaces the noteheads with the model's read melody. Selectable, but **not** the default: like every
  swap it must first win the V12 harness on accuracy *and* RAM (ADR-0020, ADR-0031). It reads notes only
  — the bespoke chord band is V17 — so ``bandTokens`` is empty. Its baked artifacts (``model.onnx`` +
  ``vocab.json``) are found via ``$SIBEI_BESPOKE_MODEL_DIR`` / ``/opt/sibei/bespoke`` (``bespoke_weights.py``).

Imports are lazy (inside ``get_engine``) so pulling in the seam — and running the heuristic engine's
tests — costs neither the tensorflow/onnxruntime import nor oemer's weights.
"""

from __future__ import annotations

from typing import Any, Callable, NamedTuple

RecognizeFn = Callable[[str, "str | None"], dict[str, Any]]

DEFAULT_ENGINE = "oemer"
ENGINE_NAMES = ("oemer", "heuristic", "bespoke")


class Engine(NamedTuple):
    name: str
    recognize: RecognizeFn
    version: Callable[[], str]


def get_engine(name: str) -> Engine:
    """Resolve an engine by name, importing only what it needs. Unknown names fail loudly."""
    if name == "oemer":
        from . import oemer

        return Engine("oemer", oemer.recognize, oemer.version)
    if name == "heuristic":
        from . import heuristic

        return Engine("heuristic", heuristic.recognize, heuristic.version)
    if name == "bespoke":
        from . import bespoke

        return Engine("bespoke", bespoke.recognize, bespoke.version)
    raise ValueError(f"unknown OMR engine {name!r}; known engines: {', '.join(ENGINE_NAMES)}")
