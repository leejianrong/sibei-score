"""Stage 2b's unit tests: the chord-band recogniser (V17d, ADR-0031).

Mirrors `test_bespoke.py`'s split: the **pure logic** — CTC-column-run to pixel-box, the detected-box
crop + offset, and the chordBand-to-staff matching window — runs anywhere, no ML deps and no weights.
A **guarded smoke** of `chord_ocr_fn` against the real `chord.onnx` runs only when onnxruntime is
importable and a baked chord pair is reachable; it checks the decode round-trips a stubbed argmax
shape, not recognition *accuracy* (the V12 harness's job, V17e).
"""

from __future__ import annotations

import os
import unittest

from sibei_omr.engines.bespoke import chords
from sibei_omr.engines.bespoke import layout as bespoke_layout

try:
    import numpy as np

    HAVE_NUMPY = True
except Exception:  # noqa: BLE001
    HAVE_NUMPY = False

_MODEL_DIR = os.environ.get("SIBEI_BESPOKE_MODEL_DIR")
_HAVE_CHORD_MODEL = False
if _MODEL_DIR and os.path.isfile(os.path.join(_MODEL_DIR, "chord.onnx")) and os.path.isfile(
    os.path.join(_MODEL_DIR, "chord-vocab.json")
):
    try:
        import onnxruntime  # noqa: F401

        _HAVE_CHORD_MODEL = HAVE_NUMPY
    except Exception:  # noqa: BLE001
        _HAVE_CHORD_MODEL = False


class FlushColumnToBox(unittest.TestCase):
    """`_flush` turns one chord's kept (column, class, prob) run into a `BandLine` — the box a token's
    beat-mapping (Q71) and the corrector's confidence display both depend on."""

    SYMBOLS = ["<blank>", "<sep>", "C", "m", "7"]

    def test_single_character_run(self) -> None:
        lines: list = []
        chords._flush([(4, 2, 0.9)], self.SYMBOLS, crop_w=100, crop_h=20, total_columns=10, lines=lines)
        self.assertEqual(len(lines), 1)
        text, (x1, y1, x2, y2), confidence = lines[0]
        self.assertEqual(text, "C")
        self.assertAlmostEqual(x1, 4 * 100 / 10)
        self.assertAlmostEqual(x2, 5 * 100 / 10)
        self.assertEqual((y1, y2), (0.0, 20.0))
        self.assertAlmostEqual(confidence, 0.9)

    def test_multi_character_run_spans_its_columns_and_averages_confidence(self) -> None:
        lines: list = []
        # "Cm7" at columns 2, 5, 6 (a CTC run need not be contiguous — repeats collapse elsewhere).
        chords._flush(
            [(2, 2, 0.8), (5, 3, 0.6), (6, 4, 0.4)], self.SYMBOLS, crop_w=200, crop_h=30, total_columns=20, lines=lines
        )
        text, (x1, _y1, x2, _y2), confidence = lines[0]
        self.assertEqual(text, "Cm7")
        self.assertAlmostEqual(x1, 2 * 200 / 20)
        self.assertAlmostEqual(x2, 7 * 200 / 20)  # last_col (6) + 1
        self.assertAlmostEqual(confidence, (0.8 + 0.6 + 0.4) / 3)

    def test_empty_run_emits_nothing(self) -> None:
        lines: list = []
        chords._flush([], self.SYMBOLS, crop_w=100, crop_h=20, total_columns=10, lines=lines)
        self.assertEqual(lines, [])

    def test_zero_total_columns_emits_nothing(self) -> None:
        # An empty/degenerate model run (T=0): never divide by zero, never emit a bogus box.
        lines: list = []
        chords._flush([(0, 2, 0.5)], self.SYMBOLS, crop_w=100, crop_h=20, total_columns=0, lines=lines)
        self.assertEqual(lines, [])


class CollapseColumns(unittest.TestCase):
    """`_collapse_columns` is the greedy CTC decode shared by `chord_ocr_fn` and the devtools viewer's
    raw character-stream display (EPIC-228) — the separator survives here; splitting on it happens
    afterward in `chord_ocr_fn`."""

    @unittest.skipUnless(HAVE_NUMPY, "needs numpy")
    def test_merges_repeats_and_drops_blank(self) -> None:
        best = np.array([0, 0, 2, 2, 0, 1, 3])
        probs = np.zeros((7, 4))
        probs[2, 2] = 0.9
        probs[5, 1] = 0.7
        probs[6, 3] = 0.5
        kept = chords._collapse_columns(best, probs, blank=0)
        self.assertEqual(kept, [(2, 2, 0.9), (5, 1, 0.7), (6, 3, 0.5)])

    @unittest.skipUnless(HAVE_NUMPY, "needs numpy")
    def test_empty_input_is_empty(self) -> None:
        best = np.array([], dtype=np.int64)
        probs = np.zeros((0, 4))
        self.assertEqual(chords._collapse_columns(best, probs, blank=0), [])


class BandBounds(unittest.TestCase):
    """`_band_bounds` is the padded, clamped crop rectangle shared by `read_band_tokens` and the
    devtools viewer — both must crop the exact same pixels the model saw."""

    def test_pads_symmetrically(self) -> None:
        box = {"x": 10.0, "y": 5.0, "w": 100.0, "h": 20.0}
        self.assertEqual(chords._band_bounds(box, pad=2, img_w=1000, img_h=1000), (8, 3, 112, 27))

    def test_clamps_to_image_edges(self) -> None:
        box = {"x": 0.0, "y": 0.0, "w": 5.0, "h": 5.0}
        left, top, right, bottom = chords._band_bounds(box, pad=10, img_w=50, img_h=50)
        self.assertEqual((left, top), (0, 0))
        self.assertLessEqual(right, 50)
        self.assertLessEqual(bottom, 50)


class ReadBandTokens(unittest.TestCase):
    """`read_band_tokens` crops the detected box per staff and offsets the OCR's local boxes back into
    full-image coordinates — the same contract `band_ocr.read_band_tokens` gives oemer/heuristic."""

    @unittest.skipUnless(HAVE_NUMPY, "needs numpy")
    def test_offsets_into_full_image_coordinates(self) -> None:
        image = np.zeros((200, 300), dtype=np.uint8)
        staves = [{"chordBand": {"x": 50.0, "y": 20.0, "w": 100.0, "h": 10.0}}]

        def stub_ocr(crop):
            self.assertEqual(crop.shape, (10 + 2 * chords._BAND_PAD, 100 + 2 * chords._BAND_PAD))
            return [("Cm7", (1.0, 2.0, 3.0, 4.0), 0.75)]

        tokens = chords.read_band_tokens(image, staves, stub_ocr)
        self.assertEqual(len(tokens), 1)
        token = tokens[0]
        self.assertEqual(token["text"], "Cm7")
        left, top = 50 - chords._BAND_PAD, 20 - chords._BAND_PAD
        self.assertEqual(token["bbox"], [left + 1, top + 2, left + 3, top + 4])
        self.assertEqual(token["confidence"], 0.75)
        self.assertEqual(token["group"], 0)  # the staff's enumerate index

    @unittest.skipUnless(HAVE_NUMPY, "needs numpy")
    def test_staff_with_no_detected_band_contributes_nothing(self) -> None:
        image = np.zeros((100, 100), dtype=np.uint8)
        staves = [{"chordBand": None}, {"chordBand": {"x": 0.0, "y": 0.0, "w": 50.0, "h": 20.0}}]
        tokens = chords.read_band_tokens(image, staves, lambda crop: [("F", (0.0, 0.0, 1.0, 1.0), 1.0)])
        self.assertEqual(len(tokens), 1)
        self.assertEqual(tokens[0]["group"], 1)  # the SECOND staff, not the first

    @unittest.skipUnless(HAVE_NUMPY, "needs numpy")
    def test_blank_text_is_dropped(self) -> None:
        image = np.zeros((100, 100), dtype=np.uint8)
        staves = [{"chordBand": {"x": 0.0, "y": 0.0, "w": 50.0, "h": 20.0}}]
        tokens = chords.read_band_tokens(image, staves, lambda crop: [("  ", (0.0, 0.0, 1.0, 1.0), 1.0)])
        self.assertEqual(tokens, [])


class MatchChordband(unittest.TestCase):
    """`_match_chordband` finds the staff's own band among Stage 1's chordBand detections."""

    def _staff(self, y_upper: float = 200.0, unit: float = 10.0, x_left: float = 100.0, x_right: float = 900.0) -> dict:
        return {"yUpper": y_upper, "unit": unit, "xLeft": x_left, "xRight": x_right}

    def test_picks_a_band_within_the_window_above_the_staff(self) -> None:
        staff = self._staff()
        # 4 staff-spaces above yUpper (within the 8-space window), overlapping x.
        band = {"x": 150.0, "y": 155.0, "w": 400.0, "h": 20.0, "score": 0.5, "cls": bespoke_layout.CLS_CHORDBAND}
        match = bespoke_layout._match_chordband(staff, [band])
        self.assertIs(match, band)

    def test_picks_a_band_near_the_edge_of_the_widened_window(self) -> None:
        # V17e regression guard: on the V12 harness corpus, real detected bands centred 6.5-7.4
        # staff-spaces above yUpper (a stacked-alteration chord needs more headroom than a plain one),
        # which the old 6-space window dropped entirely (band recall 0.42). 7 spaces above must match.
        staff = self._staff()
        band = {"x": 150.0, "y": 130.0 - 10.0, "w": 400.0, "h": 20.0, "score": 0.3, "cls": bespoke_layout.CLS_CHORDBAND}
        match = bespoke_layout._match_chordband(staff, [band])
        self.assertIs(match, band)

    def test_ignores_a_detection_below_the_staff_top(self) -> None:
        staff = self._staff()
        # Centred well below yUpper (inside the staff itself) — not a band candidate.
        far = {"x": 150.0, "y": 300.0, "w": 400.0, "h": 20.0, "score": 0.9, "cls": bespoke_layout.CLS_CHORDBAND}
        self.assertIsNone(bespoke_layout._match_chordband(staff, [far]))

    def test_ignores_a_detection_too_far_above(self) -> None:
        staff = self._staff()
        # 12 staff-spaces above yUpper — outside the 8-space window (belongs to a different system;
        # adjacent systems in the harness corpus are ~17 staff-spaces apart, so this margin is safe).
        far = {"x": 150.0, "y": 200.0 - 120.0, "w": 400.0, "h": 20.0, "score": 0.9, "cls": bespoke_layout.CLS_CHORDBAND}
        self.assertIsNone(bespoke_layout._match_chordband(staff, [far]))

    def test_ignores_a_detection_with_no_x_overlap(self) -> None:
        staff = self._staff()
        # Vertically in-window, but its x-range sits entirely left of the staff.
        elsewhere = {"x": -500.0, "y": 155.0, "w": 50.0, "h": 20.0, "score": 0.9, "cls": bespoke_layout.CLS_CHORDBAND}
        self.assertIsNone(bespoke_layout._match_chordband(staff, [elsewhere]))

    def test_picks_the_highest_scoring_candidate(self) -> None:
        staff = self._staff()
        weak = {"x": 150.0, "y": 155.0, "w": 400.0, "h": 20.0, "score": 0.3, "cls": bespoke_layout.CLS_CHORDBAND}
        strong = {"x": 150.0, "y": 160.0, "w": 400.0, "h": 20.0, "score": 0.8, "cls": bespoke_layout.CLS_CHORDBAND}
        match = bespoke_layout._match_chordband(staff, [weak, strong])
        self.assertIs(match, strong)

    def test_no_candidates_is_none(self) -> None:
        self.assertIsNone(bespoke_layout._match_chordband(self._staff(), []))


@unittest.skipUnless(_HAVE_CHORD_MODEL, "needs onnxruntime + a baked chord model ($SIBEI_BESPOKE_MODEL_DIR)")
class ChordOcrSmoke(unittest.TestCase):
    """A real `chord.onnx` decodes a blank crop without error and returns the schema `chord_ocr_fn` promises.

    Not an accuracy test — a blank strip is out of distribution — what must hold is the contract: no
    exception, and any returned line is a well-formed `(text, box, confidence)` tuple.
    """

    def test_decodes_a_blank_crop_without_error(self) -> None:
        session, symbols, blank, sep = chords.load_chords(_MODEL_DIR)  # type: ignore[misc]
        ocr = chords.chord_ocr_fn(session, symbols, blank, sep)
        crop = np.full((30, 400), 255, dtype=np.uint8)
        lines = ocr(crop)
        for text, (x1, y1, x2, y2), confidence in lines:
            self.assertIsInstance(text, str)
            self.assertTrue(0 <= x1 <= x2)
            self.assertTrue(0 <= y1 <= y2)
            self.assertTrue(0.0 <= confidence <= 1.0)


if __name__ == "__main__":
    unittest.main()
