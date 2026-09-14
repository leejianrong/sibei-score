"""Chord-band crop geometry (V13d), with a stub OCR so no PaddlePaddle is needed.

The V13 unit clause "chord-band cropping on staves at varying vertical positions" — proven here on the
pure geometry: the band is cut above the staff, and a recognised box is offset back into full-image
coordinates (the space stage-3 beat mapping needs). PaddleOCR itself is the injected seam, stubbed.
"""

from __future__ import annotations

import unittest

try:
    import numpy as np

    HAVE_NP = True
except Exception:  # noqa: BLE001
    HAVE_NP = False

if HAVE_NP:
    from sibei_omr.band_ocr import BandStaff, read_band_tokens

_W, _H = 1000, 800


def _stub(text: str, box: tuple[float, float, float, float], conf: float = 0.9):
    """An OcrFn that always returns one line at a fixed box in the CROP's local coordinates."""
    return lambda crop: [(text, box, conf)]


@unittest.skipUnless(HAVE_NP, "numpy not installed")
class BandCropTest(unittest.TestCase):
    def setUp(self) -> None:
        self.image = np.zeros((_H, _W), dtype=np.uint8)

    def test_offsets_a_recognised_box_into_full_image_coordinates(self) -> None:
        # Staff with top line at y=300, unit 16, spanning x=100..900. Band is above y=300.
        staff = BandStaff(group=0, x_left=100, x_right=900, y_upper=300, unit=16)
        # The OCR reports a box at local (20, 5)-(80, 25) inside the crop.
        tokens = read_band_tokens(self.image, [staff], _stub("Cmaj7", (20, 5, 80, 25)))
        self.assertEqual(len(tokens), 1)
        token = tokens[0]
        # Crop left = x_left = 100; crop top = y_upper - 4*unit = 300 - 64 = 236.
        self.assertEqual(token["bbox"], [120, 241, 180, 261])
        self.assertLess(token["bbox"][3], 300)  # the whole box sits above the staff top line
        self.assertEqual(token["group"], 0)
        self.assertAlmostEqual(token["confidence"], 0.9)

    def test_reads_the_band_for_a_low_placed_staff_too(self) -> None:
        staff = BandStaff(group=2, x_left=100, x_right=900, y_upper=650, unit=16)
        tokens = read_band_tokens(self.image, [staff], _stub("G7", (10, 4, 50, 24)))
        self.assertEqual(len(tokens), 1)
        self.assertEqual(tokens[0]["group"], 2)
        self.assertLess(tokens[0]["bbox"][3], 650)

    def test_drops_empty_text(self) -> None:
        staff = BandStaff(group=0, x_left=100, x_right=900, y_upper=300, unit=16)
        self.assertEqual(read_band_tokens(self.image, [staff], _stub("   ", (0, 0, 10, 10))), [])

    def test_skips_a_staff_with_no_room_above_it(self) -> None:
        # y_upper only 8 px down: the band would be off the top of the image, so nothing to crop.
        staff = BandStaff(group=0, x_left=100, x_right=900, y_upper=8, unit=16)
        self.assertEqual(read_band_tokens(self.image, [staff], _stub("C", (0, 0, 5, 5))), [])


if __name__ == "__main__":
    unittest.main()
