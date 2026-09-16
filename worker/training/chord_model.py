"""The Stage-2b chord-band recogniser: a small CRNN + CTC (V17c, ADR-0031).

One chord-band crop in — a wide, short full-width strip above the staff — a per-column character
distribution out, decoded to a character sequence by CTC and split on the separator class into the
raw chord strings that land in `bandTokens` for the V5 grammar corrector (ADR-0011). It mirrors the
Stage-2a note recogniser (`model.py`) — the same conv-stack + BiGRU + CTC shape, the same
ONNX-exportable height collapse (a plain mean, never an adaptive pool) — but is sized for the band's
geometry, which is nothing like a system crop:

- A band crop is ~1386x30 px at the corpus zoom (aspect ~46:1) — very wide, very short. Stage-2a's six
  height-pooling blocks (/64) would drive a ~32px input below one row and break, so this uses **five**
  height pools (/32), matched to a fixed input height of 32 that barely resizes the native ~30px strip.
- Width is pooled only in the first two blocks (W // 4 time steps), exactly as Stage-2a: chords are
  spread across the full page width and each is several characters, so time resolution must stay high.

Deliberately small — the v0.3 gate is accuracy *and* peak RAM/speed on CPU (ADR-0031), and this is even
leaner than Stage-2a (five blocks, not six). Exports cleanly to ONNX and runs on onnxruntime CPU in the
worker, the same runtime the other bespoke stages use.

Shape contract (identical to Stage-2a):
- input  x: [B, 1, H, W]  a grayscale band crop, fixed height H=32, variable width W (padded per batch).
- output   : [B, T, C]    logits over C classes for T = W // width_downsample() time steps.
The blank class is id 0; the chord separator is id 1 (both are real vocabulary entries, see chord-vocab.ts).
"""

from __future__ import annotations

import torch
from torch import nn


class ChordCRNN(nn.Module):
    def __init__(
        self,
        num_classes: int,
        channels: tuple[int, ...] = (32, 64, 128, 128, 256),
        rnn_hidden: int = 128,
        rnn_layers: int = 2,
    ) -> None:
        super().__init__()
        # Five conv blocks. Height is pooled by 2 every block (a 32px crop collapses to one row of
        # features); width is pooled only in the first two blocks, so time resolution stays high
        # (W // 4) — a band has many characters across its width and almost none up its height.
        pools = [(2, 2), (2, 2), (2, 1), (2, 1), (2, 1)]
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
        # Collapse the residual height to one row of features with a mean — an ONNX-exportable
        # ReduceMean, unlike an adaptive pool whose dynamic output size ONNX rejects (the V15b lesson).
        f = f.mean(dim=2)  # [B, C, W']
        f = f.permute(0, 2, 1)  # [B, W', C] — (batch, time, feature)
        f, _ = self.rnn(f)  # [B, W', 2*hidden]
        return self.fc(f)  # [B, W', num_classes] — raw logits; log_softmax lives in loss/decode
