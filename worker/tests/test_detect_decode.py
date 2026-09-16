"""Tests for the Stage-1 detector's heatmap decode + detection metrics (V16b).

Pure numpy — no torch — because the decode is exactly what the *inference* side (onnxruntime output →
boxes) reuses, so it must run without the training dep. The peak-picking and the box maths (offset +
size → a box in the original page grid) are the easy-to-get-wrong parts, so they are what these pin.
"""

from __future__ import annotations

import math
import unittest

import numpy as np

from training.detect_config import GH, GW, IN_H, IN_W, STRIDE
from training.detect_decode import decode, detection_metrics, iou, nms

NUM_CLASSES = 4  # staff, barline, chordBand, title


def _logit(p: float) -> float:
    return math.log(p / (1 - p))


def _blank_output() -> np.ndarray:
    out = np.full((NUM_CLASSES + 4, GH, GW), -10.0, dtype=np.float32)  # heat ~ 0 everywhere
    out[NUM_CLASSES : NUM_CLASSES + 2] = 0.0  # offset sigmoid -> 0.5 (cell centre)
    out[NUM_CLASSES + 2 : NUM_CLASSES + 4] = -10.0  # size ~ 0
    return out


class DecodeTest(unittest.TestCase):
    def test_reads_one_box_at_the_peak_cell(self) -> None:
        out = _blank_output()
        cls, ix, iy = 0, 10, 20  # a 'staff' peak at grid cell (10, 20)
        out[cls, iy, ix] = 10.0  # strong centre
        # offset 0.5 (logit 0) already set; size 0.5 of the input in each axis.
        out[NUM_CLASSES, iy, ix] = 0.0
        out[NUM_CLASSES + 1, iy, ix] = 0.0
        out[NUM_CLASSES + 2, iy, ix] = 0.0  # sigmoid -> 0.5 -> w = 0.5*IN_W
        out[NUM_CLASSES + 3, iy, ix] = 0.0  # h = 0.5*IN_H

        dets = decode(out, orig_w=IN_W, orig_h=IN_H, thresh=0.3)
        self.assertEqual(len(dets), 1)
        d = dets[0]
        self.assertEqual(d["cls"], cls)
        # centre = (cell + 0.5) * stride; box is centred on it with w/h = half the page.
        cx = (ix + 0.5) * STRIDE
        cy = (iy + 0.5) * STRIDE
        self.assertAlmostEqual(d["x"] + d["w"] / 2, cx, places=3)
        self.assertAlmostEqual(d["y"] + d["h"] / 2, cy, places=3)
        self.assertAlmostEqual(d["w"], 0.5 * IN_W, places=2)
        self.assertAlmostEqual(d["h"], 0.5 * IN_H, places=2)

    def test_scales_boxes_to_the_original_page_grid(self) -> None:
        out = _blank_output()
        out[1, 5, 8] = 10.0  # a 'barline' peak
        dets = decode(out, orig_w=2 * IN_W, orig_h=3 * IN_H, thresh=0.3)
        self.assertEqual(len(dets), 1)
        # A cell centre maps to the original grid by the per-axis scale factor.
        self.assertAlmostEqual(dets[0]["x"] + dets[0]["w"] / 2, (8 + 0.5) * STRIDE * 2, places=2)
        self.assertAlmostEqual(dets[0]["y"] + dets[0]["h"] / 2, (5 + 0.5) * STRIDE * 3, places=2)

    def test_below_threshold_is_dropped(self) -> None:
        out = _blank_output()
        out[0, 3, 3] = _logit(0.2)  # a weak peak
        self.assertEqual(decode(out, IN_W, IN_H, thresh=0.3), [])
        self.assertEqual(len(decode(out, IN_W, IN_H, thresh=0.1)), 1)

    def test_blank_output_yields_nothing(self) -> None:
        self.assertEqual(decode(_blank_output(), IN_W, IN_H, thresh=0.3), [])


class NmsTest(unittest.TestCase):
    def test_merges_overlapping_same_class_duplicates(self) -> None:
        # A wide object's ridge leaves two heavily-overlapping boxes; NMS keeps the higher-scoring one.
        a = {"cls": 0, "score": 0.9, "x": 0, "y": 0, "w": 100, "h": 40}
        b = {"cls": 0, "score": 0.6, "x": 5, "y": 2, "w": 100, "h": 40}
        kept = nms([a, b], iou_thresh=0.35)
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["score"], 0.9)

    def test_keeps_distinct_thin_barlines(self) -> None:
        # Two separate barlines do not overlap, so both survive.
        a = {"cls": 1, "score": 0.9, "x": 100, "y": 0, "w": 6, "h": 40}
        b = {"cls": 1, "score": 0.9, "x": 400, "y": 0, "w": 6, "h": 40}
        self.assertEqual(len(nms([a, b], iou_thresh=0.35)), 2)

    def test_never_suppresses_across_classes(self) -> None:
        # A staff and a chord band sit on top of each other but are different classes — both kept.
        staff = {"cls": 0, "score": 0.9, "x": 0, "y": 0, "w": 100, "h": 40}
        band = {"cls": 2, "score": 0.9, "x": 0, "y": 0, "w": 100, "h": 40}
        self.assertEqual(len(nms([staff, band], iou_thresh=0.35)), 2)


class IouTest(unittest.TestCase):
    def test_identical_and_disjoint(self) -> None:
        a = {"x": 0, "y": 0, "w": 10, "h": 10}
        self.assertAlmostEqual(iou(a, dict(a)), 1.0)
        self.assertEqual(iou(a, {"x": 100, "y": 100, "w": 10, "h": 10}), 0.0)

    def test_half_overlap(self) -> None:
        a = {"x": 0, "y": 0, "w": 10, "h": 10}
        b = {"x": 5, "y": 0, "w": 10, "h": 10}  # inter 50, union 150
        self.assertAlmostEqual(iou(a, b), 50 / 150)


class MetricsTest(unittest.TestCase):
    names = ["staff", "barline", "chordBand", "title"]

    def test_perfect_detection(self) -> None:
        boxes = [{"cls": 0, "x": 0, "y": 0, "w": 10, "h": 10}]
        preds = [[{**boxes[0], "score": 0.9}]]
        m = detection_metrics(preds, [boxes], self.names)
        self.assertEqual(m["micro"]["f1"], 1.0)
        self.assertEqual(m["staff_recall"], 1.0)

    def test_miss_and_false_positive(self) -> None:
        truth = [[{"cls": 0, "x": 0, "y": 0, "w": 10, "h": 10}]]
        # A prediction nowhere near the truth: one FP + one FN.
        preds = [[{"cls": 0, "x": 500, "y": 500, "w": 10, "h": 10, "score": 0.9}]]
        m = detection_metrics(preds, truth, self.names)
        self.assertEqual(m["staff_recall"], 0.0)
        self.assertEqual(m["per_class"]["staff"]["fp"], 1)
        self.assertEqual(m["per_class"]["staff"]["fn"], 1)


if __name__ == "__main__":
    unittest.main()
