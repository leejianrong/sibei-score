"""Stage-1 detector heatmap decode (V16c, ADR-0031) — mirrors worker/training/detect_decode.py.

Pure numpy: the engine turns onnxruntime output into boxes with the same peak-pick + per-class
IoU-NMS the training eval used. The shipped worker carries its own copy (training/ is not in the
image); keep it in lockstep. detection_metrics is training-only and omitted here."""

from __future__ import annotations

import numpy as np

from .detect_config import IN_H, IN_W, STRIDE


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def _maxpool3x3(heat: np.ndarray) -> np.ndarray:
    """3x3 max filter over the last two axes (per class), edge-padded — the CenterNet peak NMS."""
    padded = np.pad(heat, ((0, 0), (1, 1), (1, 1)), mode="edge")
    out = heat.copy()
    for dy in (0, 1, 2):
        for dx in (0, 1, 2):
            out = np.maximum(out, padded[:, dy : dy + heat.shape[1], dx : dx + heat.shape[2]])
    return out


def nms(dets: list[dict], iou_thresh: float = 0.35) -> list[dict]:
    """Greedy per-class non-max suppression by IoU.

    A wide object (a staff, the chord band) makes a *ridge* of heatmap peaks, so the 3x3 maxpool alone
    leaves several boxes on one object — the false positives that tanked staff/band precision. Those
    duplicates overlap heavily, so IoU-NMS collapses them to one; distinct thin barlines don't overlap,
    so they are untouched. Run per class so a staff never suppresses the chord band above it.
    """
    kept: list[dict] = []
    by_class: dict[int, list[dict]] = {}
    for d in dets:
        by_class.setdefault(d["cls"], []).append(d)
    for group in by_class.values():
        group.sort(key=lambda d: d["score"], reverse=True)
        survivors: list[dict] = []
        for d in group:
            if all(iou(d, s) < iou_thresh for s in survivors):
                survivors.append(d)
        kept.extend(survivors)
    kept.sort(key=lambda d: d["score"], reverse=True)
    return kept


def decode(
    output: np.ndarray,
    orig_w: int,
    orig_h: int,
    thresh: float = 0.3,
    topk: int = 200,
    iou_thresh: float = 0.35,
) -> list[dict]:
    """One image's model output [NC+4, GH, GW] → a list of boxes in the original page pixel grid.

    Each box is `{cls, score, x, y, w, h}` (x,y = top-left). Scores are the centre-heatmap peaks. Peaks
    are the 3x3 local maxima above `thresh`, then per-class IoU-NMS (`iou_thresh`) removes the duplicate
    boxes a wide object leaves along its ridge. Pass `iou_thresh >= 1` to disable NMS.
    """
    num_classes = output.shape[0] - 4
    heat = _sigmoid(output[:num_classes])  # [NC, GH, GW]
    offset = _sigmoid(output[num_classes : num_classes + 2])  # sub-cell centre, 0..1
    size = _sigmoid(output[num_classes + 2 : num_classes + 4])  # (w, h) as fraction of the input

    keep = heat == _maxpool3x3(heat)
    sx = orig_w / IN_W
    sy = orig_h / IN_H

    dets: list[dict] = []
    for c in range(num_classes):
        ys, xs = np.where(keep[c] & (heat[c] >= thresh))
        for iy, ix in zip(ys.tolist(), xs.tolist()):
            score = float(heat[c, iy, ix])
            cx = (ix + float(offset[0, iy, ix])) * STRIDE * sx
            cy = (iy + float(offset[1, iy, ix])) * STRIDE * sy
            w = float(size[0, iy, ix]) * IN_W * sx
            h = float(size[1, iy, ix]) * IN_H * sy
            dets.append({"cls": c, "score": score, "x": cx - w / 2, "y": cy - h / 2, "w": w, "h": h})

    if iou_thresh < 1.0:
        dets = nms(dets, iou_thresh)
    else:
        dets.sort(key=lambda d: d["score"], reverse=True)
    return dets[:topk]


def iou(a: dict, b: dict) -> float:
    ax2, ay2 = a["x"] + a["w"], a["y"] + a["h"]
    bx2, by2 = b["x"] + b["w"], b["y"] + b["h"]
    ix1, iy1 = max(a["x"], b["x"]), max(a["y"], b["y"])
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union > 0 else 0.0
