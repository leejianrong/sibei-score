"""The Stage-1 layout detector: a small anchor-free centre-point detector (V16b, ADR-0031).

One whole page in, per-class object boxes out — staff systems, barlines, the chord band and the
title block. It is the "YOLO-nano class" detector ADR-0031 calls for, built in the **heatmap** style
(CenterNet / "objects as points") rather than anchor boxes: the ADR sanctions the heatmap hybrid as
the fair alternative *when box regression is data-hungry*, and it is here — anchors + NMS need more
data and more graph machinery, and the machinery (NMS, dynamic output shapes) is exactly what fought
the V15b ONNX export. A centre-point head has none of it: the network is a plain conv stack, and the
peak-picking that turns the heatmap into boxes is host-side numpy (`detect_decode.py`), so the ONNX
graph has no dynamic op.

The domain makes this the right size: the objects are few (~6 staves, ~24 barlines, ~6 bands, ~2
title blocks a page), axis-aligned, and highly structured, so a single-scale /16 grid localises them
cleanly.

Shape contract:
- input  x: [B, 1, IN_H, IN_W]   a grayscale page, resized to the fixed model size (boxes resize with
                                  it, so a non-aspect-preserving resize is fine — the distortion is
                                  shared between image and labels).
- output   : [B, NC + 4, GH, GW] channels [0:NC] per-class centre logits; [NC:NC+2] the sub-cell
                                  centre offset; [NC+2:NC+4] the box size (w, h) as a fraction of the
                                  input. GH = IN_H // STRIDE, GW = IN_W // STRIDE.
"""

from __future__ import annotations

import torch
from torch import nn

# The geometry lives in a torch-free module so the decoder can share it (`detect_config.py`).
from .detect_config import GH, GW, IN_H, IN_W, STRIDE

__all__ = ["Detector", "IN_W", "IN_H", "STRIDE", "GW", "GH"]


class Detector(nn.Module):
    def __init__(self, num_classes: int, channels: tuple[int, ...] = (16, 32, 64, 128), head: int = 128) -> None:
        super().__init__()
        self.num_classes = num_classes
        blocks: list[nn.Module] = []
        c_in = 1
        for c_out in channels:
            blocks += [
                nn.Conv2d(c_in, c_out, 3, padding=1),
                nn.BatchNorm2d(c_out),
                nn.ReLU(inplace=True),
                nn.Conv2d(c_out, c_out, 3, padding=1),
                nn.BatchNorm2d(c_out),
                nn.ReLU(inplace=True),
                nn.MaxPool2d(2),  # /2 per block; four blocks → /16 = STRIDE
            ]
            c_in = c_out
        self.backbone = nn.Sequential(*blocks)
        self.head = nn.Sequential(
            nn.Conv2d(c_in, head, 3, padding=1),
            nn.BatchNorm2d(head),
            nn.ReLU(inplace=True),
            nn.Conv2d(head, num_classes + 4, 1),
        )
        # Bias the centre logits negative so early training starts near "no object" — the standard
        # CenterNet focal-loss init, which keeps the loss stable given how sparse positives are.
        self.head[-1].bias.data[:num_classes].fill_(-4.6)

    @staticmethod
    def stride() -> int:
        return STRIDE

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.head(self.backbone(x))  # [B, NC+4, GH, GW] — raw; sigmoids live in loss/decode
