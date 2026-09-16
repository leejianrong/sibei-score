"""Read a V17b chord-band corpus into batched tensors for the ChordCRNN (V17c, ADR-0031).

The corpus is what `pnpm dump:v17b` writes: `vocab.json` (the character class manifest — id 0 blank,
id 1 the chord separator, then one class per glyph character), `labels.jsonl` (one record per band
crop), and `crops/` (the strips). Each record is
`{ image, seed, system, level, chords, tokenIds, width, height }`; `tokenIds` are already the
character class ids for the whole band (chords joined by the separator), so nothing here needs the
vocabulary except its size and the separator id.

Train and validation split by **seed**, so validation charts are unseen — the number then measures
generalization to new music, which is the point, not memorisation.

This mirrors Stage-2a's `dataset.py` and reuses its `collate`/`load_vocab`/`_read_records`; the two
differences are band-specific:
- a short fixed height (32, close to the native ~30px strip), matching `ChordCRNN`'s /32 height pool;
- **no rotation augmentation.** A band crop is ~1386px wide and ~30px tall, so even a 1.5-degree rotation
  lifts the far end ~36px — off the top of the strip. Rotation is label-safe on a square-ish system
  crop but destructive here, so only photometric jitter and random erasing (both label-preserving) are
  applied.
"""

from __future__ import annotations

import random

import numpy as np
import torch
from PIL import Image, ImageEnhance

from .dataset import _read_records

# Re-export so training imports `load_vocab`/`collate` from one place (Stage-2a's, unchanged — the
# collate pads crops and derives CTC lengths from width // downsample, which is geometry-agnostic).
from .dataset import collate, load_vocab  # noqa: F401
from torch.utils.data import Dataset


def _augment_band(img: Image.Image) -> Image.Image:
    """Light, label-preserving augmentation for a chord-band strip.

    Chord identity is horizontal character order, so photometric jitter (brightness/contrast) is
    safe. Rotation is *not*: on a ~46:1 strip a small angle shifts the far end off-frame, so unlike
    the Stage-2a staff crop this omits it. Random erasing lives in `__getitem__` (it works on the
    normalised tensor). Heavy degradation is baked into the corpus by the dump (`--levels`); this adds
    cheap per-epoch variety so the model never memorises the finite baked variants.
    """
    if random.random() < 0.8:
        img = ImageEnhance.Brightness(img).enhance(random.uniform(0.7, 1.3))
    if random.random() < 0.8:
        img = ImageEnhance.Contrast(img).enhance(random.uniform(0.7, 1.3))
    return img


class BandCropDataset(Dataset):
    """(band crop image, character-id target) pairs from a corpus, filtered to a set of seeds."""

    def __init__(
        self,
        corpus_dir: str,
        seeds: set[int] | None = None,
        height: int = 32,
        augment: bool = False,
    ) -> None:
        self.dir = corpus_dir
        self.height = height
        self.augment = augment
        records = _read_records(corpus_dir)
        self.records = [r for r in records if seeds is None or int(r["seed"]) in seeds]
        if not self.records:
            raise ValueError(f"no band crops for the requested seeds in {corpus_dir}")

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor, int]:
        rec = self.records[index]
        img = Image.open(f"{self.dir}/{rec['image']}").convert("L")
        if self.augment:
            img = _augment_band(img)
        # Resize to the fixed model height, preserving aspect so glyph proportions survive.
        width = max(1, round(img.width * self.height / img.height))
        img = img.resize((width, self.height), Image.BILINEAR)
        arr = np.asarray(img, dtype=np.float32) / 255.0
        tensor = torch.from_numpy(arr).unsqueeze(0)  # [1, H, W]
        tensor = (tensor - 0.5) / 0.5  # to ~[-1, 1]
        if self.augment and random.random() < 0.3:
            # Random erasing: a small blank patch, so the model is robust to a smudge or a mark.
            _, h, w = tensor.shape
            ew = random.randint(max(1, w // 60), max(2, w // 25))
            eh = random.randint(max(1, h // 6), max(2, h // 3))
            ex, ey = random.randint(0, max(0, w - ew)), random.randint(0, max(0, h - eh))
            tensor[:, ey : ey + eh, ex : ex + ew] = random.uniform(-1.0, 1.0)
        target = torch.tensor(rec["tokenIds"], dtype=torch.long)
        return tensor, target, width
