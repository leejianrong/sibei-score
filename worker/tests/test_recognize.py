"""Unit tests for recognize.py helpers that don't need oemer/onnxruntime loaded.

``recognize`` imports oemer lazily (inside ``recognize()``), so the module — and the pure helpers
here — import on a bare host. That is deliberate: KAN-1391's regression is in ``_zone_bounds``, a
pure normalisation, and we want it covered where oemer can't run (an 8 GB dev host OOM-kills oemer).
The numpy-backed case reproduces the ACTUAL failure trigger and is skipped when numpy is absent.
"""

from __future__ import annotations

import unittest

from sibei_omr.recognize import _zone_bounds

try:
    import numpy as np

    HAVE_NUMPY = True
except Exception:  # noqa: BLE001 — numpy absent on a bare host; skip the collapse reproduction.
    HAVE_NUMPY = False


class ZoneBoundsTest(unittest.TestCase):
    def test_range_uses_start_stop(self) -> None:
        # The normal, ragged case: zones stay `range` objects.
        self.assertEqual(_zone_bounds(range(40, 190)), [40, 190])

    def test_slice_uses_start_stop(self) -> None:
        self.assertEqual(_zone_bounds(slice(0, 12)), [0, 12])

    def test_list_of_indices_is_half_open(self) -> None:
        # An array-like zone (no .start/.stop): [first, last + 1], matching range's half-open bounds.
        self.assertEqual(_zone_bounds([40, 41, 42, 43]), [40, 44])

    def test_empty_array_like(self) -> None:
        self.assertEqual(_zone_bounds([]), [0, 0])

    @unittest.skipUnless(HAVE_NUMPY, "numpy not installed")
    def test_ndarray_row_from_collapsed_zones(self) -> None:
        # KAN-1391 reproduction: when every range is the SAME length, np.array(..., dtype=object)
        # collapses the list into a 2-D int array, so a row is an ndarray, not a range. The old
        # `int(z.start)` raised AttributeError on such a row; _zone_bounds must recover [start, stop).
        zones = np.array([range(0, 10), range(10, 20), range(20, 30)], dtype=object)
        self.assertEqual(zones.ndim, 2, "equal-length ranges should collapse to a 2-D array")
        row = zones[0]
        self.assertIsInstance(row, np.ndarray)
        self.assertFalse(hasattr(row, "start"))  # the exact shape that used to throw
        self.assertEqual([_zone_bounds(z) for z in zones], [[0, 10], [10, 20], [20, 30]])

    @unittest.skipUnless(HAVE_NUMPY, "numpy not installed")
    def test_ndarray_ragged_stays_ranges(self) -> None:
        # The passing case: unequal lengths keep a 1-D object array of range objects.
        zones = np.array([range(0, 10), range(10, 25)], dtype=object)
        self.assertEqual(zones.ndim, 1)
        self.assertEqual([_zone_bounds(z) for z in zones], [[0, 10], [10, 25]])


if __name__ == "__main__":
    unittest.main()
