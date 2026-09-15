"""Read a V15a training corpus into batched tensors for the CRNN (V15b, ADR-0031).

The corpus is what `pnpm dump:v15a` writes: `vocab.json` (the shared class manifest, id = array
index, blank at 0), `labels.jsonl` (one record per crop), and `crops/` (the images). Each record is
`{ image, seed, system, level, tokenIds, tokens, width, height }`; `tokenIds` are already the class
ids, so nothing here needs the vocabulary except its size.

Train and validation split by **seed**, so validation charts are unseen — the number then measures
generalization to new music, which is the point, not memorisation.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

import numpy as np
import torch
from PIL import Image
from torch.utils.data import Dataset


@dataclass
class Vocab:
    symbols: list[str]
    size: int
    blank: int


def load_vocab(corpus_dir: str) -> Vocab:
    with open(os.path.join(corpus_dir, "vocab.json"), encoding="utf-8") as fh:
        data = json.load(fh)
    return Vocab(symbols=data["symbols"], size=int(data["size"]), blank=int(data.get("blank", 0)))


def _read_records(corpus_dir: str) -> list[dict]:
    records: list[dict] = []
    with open(os.path.join(corpus_dir, "labels.jsonl"), encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


class CropDataset(Dataset):
    """(crop image, token-id target) pairs from a corpus, filtered to a set of seeds."""

    def __init__(self, corpus_dir: str, seeds: set[int] | None = None, height: int = 128) -> None:
        self.dir = corpus_dir
        self.height = height
        records = _read_records(corpus_dir)
        self.records = [r for r in records if seeds is None or int(r["seed"]) in seeds]
        if not self.records:
            raise ValueError(f"no crops for the requested seeds in {corpus_dir}")

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor, int]:
        rec = self.records[index]
        img = Image.open(os.path.join(self.dir, rec["image"])).convert("L")
        # Resize to the fixed model height, preserving aspect so glyph proportions survive.
        width = max(1, round(img.width * self.height / img.height))
        img = img.resize((width, self.height), Image.BILINEAR)
        arr = np.asarray(img, dtype=np.float32) / 255.0
        tensor = torch.from_numpy(arr).unsqueeze(0)  # [1, H, W]
        tensor = (tensor - 0.5) / 0.5  # to ~[-1, 1]
        target = torch.tensor(rec["tokenIds"], dtype=torch.long)
        return tensor, target, width


def collate(
    batch: list[tuple[torch.Tensor, torch.Tensor, int]],
    width_downsample: int = 4,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    """Pad crops to the batch's widest, and derive the CTC input/target lengths."""
    images, targets, widths = zip(*batch)
    height = images[0].shape[1]
    max_w = max(img.shape[2] for img in images)
    padded = torch.zeros(len(images), 1, height, max_w)
    for i, img in enumerate(images):
        padded[i, :, :, : img.shape[2]] = img
    # A padded region contributes blank columns; the true input length is the unpadded width // 4.
    input_lengths = torch.tensor([max(1, w // width_downsample) for w in widths], dtype=torch.long)
    target_lengths = torch.tensor([t.numel() for t in targets], dtype=torch.long)
    targets_cat = torch.cat(targets) if targets else torch.zeros(0, dtype=torch.long)
    return padded, targets_cat, input_lengths, target_lengths
