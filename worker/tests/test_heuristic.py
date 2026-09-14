"""The heuristic engine's unit tests (V13c).

OpenCV only, no ML weights, so these run anywhere cv2 + numpy are importable — including a small host
where oemer is OOM-killed, which is the engine's whole reason to exist. The input is a staff drawn
deterministically with cv2 (five lines, two barlines, three noteheads), so the assertions are exact
and need no committed image or real photo.
"""

from __future__ import annotations

import os
import tempfile
import unittest

try:
    import cv2
    import numpy as np

    HAVE_CV = True
except Exception:  # noqa: BLE001 — cv2/numpy absent on a bare host; skip rather than error.
    HAVE_CV = False

if HAVE_CV:
    from sibei_omr.engines import get_engine
    from sibei_omr.engines.heuristic import recognize

# The staff we draw: five lines 20 px apart, spanning most of the width; two barlines; three noteheads.
_W, _H = 1200, 400
_LINE_YS = [150, 170, 190, 210, 230]
_UNIT = 20
_X_LEFT, _X_RIGHT = 100, 1100
_BARLINE_XS = [400, 800]
_NOTE_CENTERS = [(250, 190), (550, 170), (950, 210)]


def _draw_chart() -> str:
    img = np.full((_H, _W), 255, dtype=np.uint8)
    for y in _LINE_YS:
        cv2.line(img, (_X_LEFT, y), (_X_RIGHT, y), 0, 2)
    for x in _BARLINE_XS:
        cv2.line(img, (x, _LINE_YS[0]), (x, _LINE_YS[-1]), 0, 3)
    for cx, cy in _NOTE_CENTERS:
        cv2.ellipse(img, (cx, cy), (12, 8), 0, 0, 360, 0, -1)  # filled notehead
        cv2.line(img, (cx + 11, cy), (cx + 11, cy - 3 * _UNIT), 0, 2)  # a stem, to be ignored
    handle = tempfile.NamedTemporaryFile(prefix="sibei-heur-", suffix=".png", delete=False)
    handle.close()
    cv2.imwrite(handle.name, img)
    return handle.name


@unittest.skipUnless(HAVE_CV, "cv2/numpy not installed")
class HeuristicEngineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.path = _draw_chart()
        cls.doc = recognize(cls.path, "chart.png")

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            os.unlink(cls.path)
        except OSError:
            pass

    def test_emits_a_v2_heuristic_document(self) -> None:
        self.assertEqual(self.doc["schemaVersion"], 2)
        self.assertEqual(self.doc["source"]["engine"], "heuristic")
        self.assertEqual(self.doc["source"]["imagePath"], "chart.png")
        self.assertEqual(self.doc["source"]["imageWidth"], _W)
        self.assertEqual(self.doc["bandTokens"], [])  # chord band is V13d

    def test_finds_the_staff_with_plausible_geometry(self) -> None:
        self.assertEqual(len(self.doc["staves"]), 1)
        staff = self.doc["staves"][0]
        self.assertAlmostEqual(staff["yUpper"], _LINE_YS[0], delta=3)
        self.assertAlmostEqual(staff["yLower"], _LINE_YS[-1], delta=3)
        self.assertAlmostEqual(staff["unitSize"], _UNIT, delta=2)

    def test_finds_both_barlines(self) -> None:
        xs = sorted((b["bbox"][0] + b["bbox"][2]) / 2 for b in self.doc["barlines"])
        self.assertEqual(len(xs), 2)
        for got, expected in zip(xs, _BARLINE_XS):
            self.assertAlmostEqual(got, expected, delta=6)

    def test_finds_the_noteheads_not_the_stems(self) -> None:
        heads = self.doc["noteheads"]
        # Three heads drawn; allow the engine to miss/merge one but not to hallucinate stems as heads.
        self.assertGreaterEqual(len(heads), 2)
        self.assertLessEqual(len(heads), 3)
        for head in heads:
            x1, y1, x2, y2 = head["bbox"]
            self.assertTrue(0 <= x1 < x2 <= _W and 0 <= y1 < y2 <= _H)
            self.assertEqual(head["group"], 0)
            self.assertEqual(head["label"], "QUARTER")

    def test_all_coordinates_are_inside_the_image(self) -> None:
        for obj in self.doc["noteheads"] + self.doc["barlines"]:
            x1, y1, x2, y2 = obj["bbox"]
            self.assertTrue(0 <= x1 <= _W and 0 <= x2 <= _W)
            self.assertTrue(0 <= y1 <= _H and 0 <= y2 <= _H)

    def test_the_seam_resolves_the_engine(self) -> None:
        engine = get_engine("heuristic")
        self.assertEqual(engine.name, "heuristic")
        self.assertEqual(engine.version(), self.doc["source"]["engineVersion"])


class SeamTest(unittest.TestCase):
    def test_unknown_engine_fails_loudly(self) -> None:
        from sibei_omr.engines import get_engine

        with self.assertRaises(ValueError):
            get_engine("nope")


if __name__ == "__main__":
    unittest.main()
