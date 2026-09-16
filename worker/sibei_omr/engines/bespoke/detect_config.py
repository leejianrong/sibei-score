"""Stage-1 detector geometry (V16c, ADR-0031) — mirrors worker/training/detect_config.py.

The engine ships without the training package, so it carries its own torch-free copy of the
detector constants and decode (like ``bespoke`` mirrors ``vocab.ts``). Keep in lockstep with
training when the model input geometry changes."""

from __future__ import annotations

# Fixed model input. A4/Letter render tall (aspect ~0.71 w/h), so IN_H > IN_W; both are multiples of
# STRIDE so the grid is exact. A page is resized straight to this — its boxes carry the same resize.
#
# Stride is /8, not /16: a staff and the chord band above it are short and vertically adjacent (~2-3
# grid rows apart at /16), so a coarse grid confused them and dropped ~1/3 of staves. /8 doubles the
# vertical grid resolution, separating the two — staff is the must-win class (ADR-0031).
IN_W = 512
IN_H = 704
STRIDE = 8
GW = IN_W // STRIDE  # 64
GH = IN_H // STRIDE  # 88
