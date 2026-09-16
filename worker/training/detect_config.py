"""Shared geometry for the Stage-1 detector (V16b, ADR-0031) — torch-free on purpose.

The model (`detect_model.py`, torch) and the decoder (`detect_decode.py`, numpy only) both need these
constants, and the decoder must import nothing heavy so the *inference* side can reuse its peak-picking
on onnxruntime output without pulling torch in. Keeping the constants here lets `detect_decode` stay
pure numpy.
"""

from __future__ import annotations

# Fixed model input. A4/Letter render tall (aspect ~0.71 w/h), so IN_H > IN_W; both are multiples of
# STRIDE so the /16 grid is exact. A page is resized straight to this — its boxes carry the same resize.
IN_W = 512
IN_H = 704
STRIDE = 16
GW = IN_W // STRIDE  # 32
GH = IN_H // STRIDE  # 44
