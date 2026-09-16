"""Read a V16a detection corpus into batched tensors + CenterNet targets (V16b, ADR-0031).

The corpus is what `pnpm dump:v16a` writes: `classes.json` (the class manifest, id = array index),
`labels.jsonl` (one record per page: `{ image, seed, page, level, width, height, boxes:[{cls,clsId,x,y,w,h}] }`),
and `pages/` (the page images). Train/validation split by **seed**, so validation pages are unseen —
the number then measures generalization to new music, not memorisation.

The dump baked only *photometric* degradation (it left boxes pixel-aligned); the **geometric** half —
perspective, rotation — is applied here, on the fly, transforming the image and its boxes **jointly**
so the labels stay correct. That is the label-safe split the V15 notes describe, moved to Stage 1: a
detector has to survive the keystone warp of a real photo, and this is where it learns it.
"""

from __future__ import annotations

import json
import os
import random

import numpy as np
import torch
from PIL import Image, ImageEnhance
from torch.utils.data import Dataset

from .detect_model import GH, GW, IN_H, IN_W, STRIDE


def load_classes(corpus_dir: str) -> list[str]:
    with open(os.path.join(corpus_dir, "classes.json"), encoding="utf-8") as fh:
        return list(json.load(fh)["classes"])


def _read_records(corpus_dir: str) -> list[dict]:
    records: list[dict] = []
    with open(os.path.join(corpus_dir, "labels.jsonl"), encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def corpus_seeds(corpus_dir: str) -> list[int]:
    return sorted({int(r["seed"]) for r in _read_records(corpus_dir)})


# --- geometry: a joint perspective warp of image + boxes (the deferred label-safe aug) ---


def _homography(src: list[tuple[float, float]], dst: list[tuple[float, float]]) -> np.ndarray:
    """3x3 homography mapping the four src points to the four dst points (h33 = 1)."""
    a = []
    b = []
    for (x, y), (u, v) in zip(src, dst):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        b.append(u)
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        b.append(v)
    h = np.linalg.solve(np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64))
    return np.append(h, 1.0).reshape(3, 3)


def _warp_point(h: np.ndarray, x: float, y: float) -> tuple[float, float]:
    denom = h[2, 0] * x + h[2, 1] * y + h[2, 2]
    return (h[0, 0] * x + h[0, 1] * y + h[0, 2]) / denom, (h[1, 0] * x + h[1, 1] * y + h[1, 2]) / denom


def _perspective_augment(img: Image.Image, boxes: list[dict], jitter: float) -> tuple[Image.Image, list[dict]]:
    """Warp the page to a jittered quad and carry the boxes through the same homography (AABB out)."""
    w, h = img.width, img.height
    src = [(0.0, 0.0), (float(w), 0.0), (float(w), float(h)), (0.0, float(h))]
    jx, jy = jitter * w, jitter * h
    tx, ty = random.uniform(-jx, jx), random.uniform(-jy, jy)  # a small global shift too
    dst = [(sx + random.uniform(-jx, jx) + tx, sy + random.uniform(-jy, jy) + ty) for sx, sy in src]

    h_fwd = _homography(src, dst)  # src -> dst, for the boxes
    h_bwd = _homography(dst, src)  # dst -> src, for PIL (it maps output pixels back to the source)
    coeffs = h_bwd.flatten()[:8].tolist()
    warped = img.transform((w, h), Image.PERSPECTIVE, coeffs, resample=Image.BILINEAR, fillcolor=255)

    out: list[dict] = []
    for box in boxes:
        corners = [
            (box["x"], box["y"]),
            (box["x"] + box["w"], box["y"]),
            (box["x"] + box["w"], box["y"] + box["h"]),
            (box["x"], box["y"] + box["h"]),
        ]
        pts = [_warp_point(h_fwd, cx, cy) for cx, cy in corners]
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        x1, y1 = max(0.0, min(xs)), max(0.0, min(ys))
        x2, y2 = min(float(w), max(xs)), min(float(h), max(ys))
        if x2 - x1 >= 3 and y2 - y1 >= 3:
            out.append({"cls": box["cls"], "x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1})
    return warped, out


def _photometric(img: Image.Image) -> Image.Image:
    if random.random() < 0.8:
        img = ImageEnhance.Brightness(img).enhance(random.uniform(0.7, 1.3))
    if random.random() < 0.8:
        img = ImageEnhance.Contrast(img).enhance(random.uniform(0.7, 1.3))
    return img


# --- CenterNet Gaussian targets ---


def _gaussian_radius(h: float, w: float, min_overlap: float = 0.3) -> int:
    """The CenterNet radius: how far a peak can drift and still overlap the box by `min_overlap`."""
    import math

    def solve(a: float, b: float, c: float) -> float:
        disc = b * b - 4 * a * c
        return (b + math.sqrt(max(disc, 0.0))) / (2 * a)

    r1 = solve(1, h + w, w * h * (1 - min_overlap) / (1 + min_overlap))
    r2 = solve(4, 2 * (h + w), (1 - min_overlap) * w * h)
    r3 = solve(4 * min_overlap, -2 * min_overlap * (h + w), (min_overlap - 1) * w * h)
    return max(0, int(min(r1, r2, r3)))


def _draw_gaussian(heat: np.ndarray, cx: int, cy: int, radius: int) -> None:
    diameter = 2 * radius + 1
    sigma = diameter / 6.0
    ax = np.arange(-radius, radius + 1)
    g = np.exp(-(ax[:, None] ** 2 + ax[None, :] ** 2) / (2 * sigma * sigma + 1e-9))
    gh, gw = heat.shape
    left, right = min(cx, radius), min(gw - cx, radius + 1)
    top, bottom = min(cy, radius), min(gh - cy, radius + 1)
    if right <= -left or bottom <= -top:
        return
    masked_heat = heat[cy - top : cy + bottom, cx - left : cx + right]
    masked_g = g[radius - top : radius + bottom, radius - left : radius + right]
    np.maximum(masked_heat, masked_g, out=masked_heat)


class DetectDataset(Dataset):
    """(page image, CenterNet target) pairs from a corpus, filtered to a set of seeds."""

    def __init__(self, corpus_dir: str, num_classes: int, seeds: set[int] | None = None, augment: bool = False, jitter: float = 0.04) -> None:
        self.dir = corpus_dir
        self.num_classes = num_classes
        self.augment = augment
        self.jitter = jitter
        records = _read_records(corpus_dir)
        self.records = [r for r in records if seeds is None or int(r["seed"]) in seeds]
        if not self.records:
            raise ValueError(f"no pages for the requested seeds in {corpus_dir}")

    def __len__(self) -> int:
        return len(self.records)

    def _boxes_in_input(self, rec: dict) -> list[dict]:
        sx = IN_W / rec["width"]
        sy = IN_H / rec["height"]
        return [{"cls": int(b["clsId"]), "x": b["x"] * sx, "y": b["y"] * sy, "w": b["w"] * sx, "h": b["h"] * sy} for b in rec["boxes"]]

    def __getitem__(self, index: int):
        rec = self.records[index]
        img = Image.open(os.path.join(self.dir, rec["image"])).convert("L").resize((IN_W, IN_H), Image.BILINEAR)
        boxes = self._boxes_in_input(rec)
        if self.augment:
            img = _photometric(img)
            if random.random() < 0.85:
                img, boxes = _perspective_augment(img, boxes, self.jitter)

        arr = np.asarray(img, dtype=np.float32) / 255.0
        tensor = torch.from_numpy((arr - 0.5) / 0.5).unsqueeze(0)  # [1, IN_H, IN_W]

        heat = np.zeros((self.num_classes, GH, GW), dtype=np.float32)
        offset = np.zeros((2, GH, GW), dtype=np.float32)
        size = np.zeros((2, GH, GW), dtype=np.float32)
        mask = np.zeros((1, GH, GW), dtype=np.float32)
        for box in boxes:
            cx = box["x"] + box["w"] / 2
            cy = box["y"] + box["h"] / 2
            fx, fy = cx / STRIDE, cy / STRIDE
            ix, iy = int(fx), int(fy)
            if not (0 <= ix < GW and 0 <= iy < GH):
                continue
            radius = _gaussian_radius(box["h"] / STRIDE, box["w"] / STRIDE)
            _draw_gaussian(heat[box["cls"]], ix, iy, radius)
            offset[0, iy, ix] = fx - ix
            offset[1, iy, ix] = fy - iy
            size[0, iy, ix] = box["w"] / IN_W
            size[1, iy, ix] = box["h"] / IN_H
            mask[0, iy, ix] = 1.0

        target = {
            "heat": torch.from_numpy(heat),
            "offset": torch.from_numpy(offset),
            "size": torch.from_numpy(size),
            "mask": torch.from_numpy(mask),
        }
        # GT boxes in input coords, for detection-metric evaluation.
        gt = [{"cls": b["cls"], "x": b["x"], "y": b["y"], "w": b["w"], "h": b["h"]} for b in boxes]
        return tensor, target, gt


def collate(batch: list):
    images, targets, gts = zip(*batch)
    images = torch.stack(images)
    stacked = {k: torch.stack([t[k] for t in targets]) for k in targets[0]}
    return images, stacked, list(gts)
