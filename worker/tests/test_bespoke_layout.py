"""Stage-1 layout assembly: detections → systems (V16c, ADR-0031).

The onnx inference (`detect_layout`) needs a baked model, but the *assembly* of decoded boxes into
staves — clustering detections by staff-centre y and deriving each system's geometry — is pure and is
where the easy-to-get-wrong logic lives, so it is unit-tested directly with fabricated detections. Two
things must hold: one system per printed line (staff + its barlines cluster together, two lines stay
apart), and the staff *height* comes from the reliable barlines (a barline box spans the staff).
"""

from __future__ import annotations

import unittest

from sibei_omr.engines.bespoke import layout


def _staff(cx: float, cy: float, w: float, h: float, score: float = 0.5) -> dict:
    return {"cls": layout.CLS_STAFF, "score": score, "x": cx - w / 2, "y": cy - h / 2, "w": w, "h": h}


def _barline(cx: float, cy: float, h: float, w: float = 6.0, score: float = 0.9) -> dict:
    return {"cls": layout.CLS_BARLINE, "score": score, "x": cx - w / 2, "y": cy - h / 2, "w": w, "h": h}


class ClusterByY(unittest.TestCase):
    def test_two_lines_stay_separate(self) -> None:
        page_w = 800
        staff_a = [_staff(400, 100, 700, 40)]
        staff_b = [_staff(400, 400, 700, 40)]
        bars_a = [_barline(300, 100, 40), _barline(500, 100, 40)]
        bars_b = [_barline(300, 400, 40), _barline(500, 400, 40)]
        clusters = layout._cluster_by_y(staff_a + staff_b, bars_a + bars_b, gap=0.75 * 40)
        self.assertEqual(len(clusters), 2)
        # Each cluster has its own staff + two barlines.
        for c in clusters:
            self.assertEqual(len(c["staves"]), 1)
            self.assertEqual(len(c["barlines"]), 2)

    def test_staff_and_its_barlines_cluster_together(self) -> None:
        clusters = layout._cluster_by_y([_staff(400, 200, 700, 40)], [_barline(350, 202, 40), _barline(550, 198, 40)], gap=30)
        self.assertEqual(len(clusters), 1)
        self.assertEqual(len(clusters[0]["staves"]), 1)
        self.assertEqual(len(clusters[0]["barlines"]), 2)


class StaffGeometry(unittest.TestCase):
    def test_height_comes_from_barlines(self) -> None:
        # Staff box height is wrong (60), but the barlines say 40 — the barlines win.
        cluster = {"staves": [_staff(400, 200, 700, 60)], "barlines": [_barline(350, 200, 40), _barline(550, 200, 40)]}
        s = layout._staff_from_cluster(cluster, page_w=800, staff_h_est=40)
        self.assertAlmostEqual(s["yLower"] - s["yUpper"], 40, delta=1e-6)
        self.assertAlmostEqual(s["unit"], 10, delta=1e-6)  # 40 / 4
        self.assertAlmostEqual(s["yCenter"], 200, delta=1e-6)

    def test_full_width_from_staff_box(self) -> None:
        cluster = {"staves": [_staff(400, 200, 700, 40)], "barlines": [_barline(350, 200, 40)]}
        s = layout._staff_from_cluster(cluster, page_w=800, staff_h_est=40)
        self.assertAlmostEqual(s["xLeft"], 50, delta=1e-6)  # 400 - 700/2
        self.assertAlmostEqual(s["xRight"], 750, delta=1e-6)

    def test_falls_back_to_barlines_when_no_staff(self) -> None:
        # A real-photo system where the staff box scored too low: geometry still comes from barlines.
        cluster = {"staves": [], "barlines": [_barline(300, 200, 40), _barline(600, 200, 40)]}
        s = layout._staff_from_cluster(cluster, page_w=800, staff_h_est=40)
        self.assertAlmostEqual(s["yLower"] - s["yUpper"], 40, delta=1e-6)
        self.assertGreaterEqual(s["xLeft"], 0.0)
        self.assertLessEqual(s["xRight"], 800.0)


if __name__ == "__main__":
    unittest.main()
