"""Decode the Stage-1 detector's heatmap output into boxes, and score detections (V16b, ADR-0031).

Pure numpy, no torch — so the *inference* side can reuse the same peak-picking on onnxruntime output
(the worker's `engines/bespoke/layout.py`, V16c) exactly as the CRNN's greedy decode is shared. The
ONNX graph stops at the conv head; turning the heatmap into boxes is this host-side code, which is why
the graph carries no NMS and no dynamic op (the V15b export lesson).

Decoding is CenterNet-standard: sigmoid the centre heatmap, keep 3x3 local maxima (a maxpool "NMS"),
take the peaks above a score threshold, and read the sub-cell offset and box size at each. Boxes come
back in the *original* page pixel grid the caller passes, not the fixed model grid.
"""

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


def decode(output: np.ndarray, orig_w: int, orig_h: int, thresh: float = 0.3, topk: int = 200) -> list[dict]:
    """One image's model output [NC+4, GH, GW] → a list of boxes in the original page pixel grid.

    Each box is `{cls, score, x, y, w, h}` (x,y = top-left). Scores are the centre-heatmap peaks.
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


def detection_metrics(
    preds: list[list[dict]],
    truths: list[list[dict]],
    class_names: list[str],
    iou_thr: float = 0.5,
    score_thr: float = 0.3,
) -> dict:
    """Greedy IoU matching per class over a set of images → per-class and overall precision/recall/F1.

    Staff recall is the headline (ADR-0031: staff detection is the must-win), so it is surfaced too.
    """
    nc = len(class_names)
    tp = [0] * nc
    fp = [0] * nc
    fn = [0] * nc
    for image_preds, image_truths in zip(preds, truths):
        for c in range(nc):
            pc = sorted([p for p in image_preds if p["cls"] == c and p["score"] >= score_thr], key=lambda p: p["score"], reverse=True)
            tc = [t for t in image_truths if t["cls"] == c]
            matched = [False] * len(tc)
            for p in pc:
                best_j, best_iou = -1, iou_thr
                for j, t in enumerate(tc):
                    if matched[j]:
                        continue
                    v = iou(p, t)
                    if v >= best_iou:
                        best_j, best_iou = j, v
                if best_j >= 0:
                    matched[best_j] = True
                    tp[c] += 1
                else:
                    fp[c] += 1
            fn[c] += matched.count(False)

    def prf(t: int, f: int, n: int) -> tuple[float, float, float]:
        precision = t / (t + f) if (t + f) else 0.0
        recall = t / (t + n) if (t + n) else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
        return precision, recall, f1

    per_class: dict[str, dict] = {}
    for c, name in enumerate(class_names):
        p, r, f1 = prf(tp[c], fp[c], fn[c])
        per_class[name] = {"precision": p, "recall": r, "f1": f1, "tp": tp[c], "fp": fp[c], "fn": fn[c]}
    micro_p, micro_r, micro_f1 = prf(sum(tp), sum(fp), sum(fn))
    return {
        "per_class": per_class,
        "micro": {"precision": micro_p, "recall": micro_r, "f1": micro_f1},
        "staff_recall": per_class.get("staff", {}).get("recall", 0.0),
    }
