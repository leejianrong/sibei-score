"""The Stage-2a staff recogniser: a small CRNN + CTC (V15b, ADR-0031).

One staff-system crop in, a per-column class distribution out, decoded to a note/rest token sequence
by CTC. Deliberately small — the v0.3 gate is accuracy *and* peak RAM/speed on CPU (ADR-0031), and a
lead-sheet staff is a narrow problem, so a light CNN + a single BiGRU is the right size to start. It
exports cleanly to ONNX and runs on onnxruntime CPU in the worker, the same runtime oemer already uses.

Shape contract:
- input  x: [B, 1, H, W]  a grayscale crop, fixed height H, variable width W (padded per batch).
- output   : [B, T, C]    logits over C classes for T = W // width_downsample() time steps.
The blank class is id 0 (matches PyTorch `nn.CTCLoss(blank=0)` and the vocabulary manifest).
"""

from __future__ import annotations

import torch
from torch import nn


class CRNN(nn.Module):
    def __init__(
        self,
        num_classes: int,
        channels: tuple[int, ...] = (32, 64, 128, 128, 256, 256),
        rnn_hidden: int = 128,
        rnn_layers: int = 2,
    ) -> None:
        super().__init__()
        # Six conv blocks. Height is pooled by 2 every block (so a tall crop collapses toward one
        # row of features); width is pooled only in the first two blocks, so time resolution stays
        # high (W // 4) — a staff has many events across its width and few up its height.
        pools = [(2, 2), (2, 2), (2, 1), (2, 1), (2, 1), (2, 1)]
        layers: list[nn.Module] = []
        c_in = 1
        for c_out, (ph, pw) in zip(channels, pools):
            layers += [
                nn.Conv2d(c_in, c_out, kernel_size=3, padding=1),
                nn.BatchNorm2d(c_out),
                nn.ReLU(inplace=True),
                nn.MaxPool2d((ph, pw)),
            ]
            c_in = c_out
        self.cnn = nn.Sequential(*layers)
        # Force whatever height survives the conv stack to exactly 1, so the features become a pure
        # width sequence regardless of the input height chosen.
        self.height_pool = nn.AdaptiveAvgPool2d((1, None))
        self.rnn = nn.GRU(
            channels[-1],
            rnn_hidden,
            num_layers=rnn_layers,
            bidirectional=True,
            batch_first=True,
        )
        self.fc = nn.Linear(rnn_hidden * 2, num_classes)

    @staticmethod
    def width_downsample() -> int:
        """W of the input maps to W // 4 time steps (two width-pooling blocks of stride 2)."""
        return 4

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        f = self.cnn(x)  # [B, C, H', W']
        f = self.height_pool(f)  # [B, C, 1, W']
        f = f.squeeze(2)  # [B, C, W']
        f = f.permute(0, 2, 1)  # [B, W', C] — (batch, time, feature)
        f, _ = self.rnn(f)  # [B, W', 2*hidden]
        return self.fc(f)  # [B, W', num_classes] — raw logits; log_softmax lives in loss/decode
