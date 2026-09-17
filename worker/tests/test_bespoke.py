"""The bespoke engine's unit tests (V15c Stage-2a, V16c Stage-1, V17d Stage-2b; ADR-0031).

Two layers, mirroring the engine's two halves (Stage 2b's own pure-logic + smoke tests live in
`test_chords.py`, alongside `chords.py` and `layout._match_chordband`):

- The **pure logic** — flat-semantic symbol parsing (the inverse of `packages/synth/src/vocab.ts`),
  crop reconstruction, and the CTC-column → pixel-x coordinate derivation — runs anywhere, no ML deps
  and no weights. This is the load-bearing, deterministic part a probe failure would hide in, so it is
  tested exactly.
- A **guarded smoke** of the full `recognize()` runs only when onnxruntime + cv2 are importable *and* a
  baked Stage-1+2a model pair is reachable (`$SIBEI_BESPOKE_MODEL_DIR`, dev: out/v15b + detect.onnx). It
  asserts the document is schema-shaped and every coordinate (including any band token's) lands inside
  the image — recognition *accuracy* is the V12 harness's job (docs/eval.md), not a unit test's. The
  chord pair is not required for this smoke: a dir without `chord.onnx` still recognises notes and
  simply carries no band (V17d's graceful-degrade contract), so `bandTokens` may be empty **or**
  populated here depending on what the test environment's model dir happens to hold.
"""

from __future__ import annotations

import os
import tempfile
import unittest

from sibei_omr.engines import bespoke
from sibei_omr.engines.bespoke import stage2a

try:
    import cv2
    import numpy as np

    HAVE_CV = True
except Exception:  # noqa: BLE001
    HAVE_CV = False

_MODEL_DIR = os.environ.get("SIBEI_BESPOKE_MODEL_DIR")
_HAVE_MODEL = False
if (
    _MODEL_DIR
    and os.path.isfile(os.path.join(_MODEL_DIR, "model.onnx"))
    and os.path.isfile(os.path.join(_MODEL_DIR, "detect.onnx"))
):
    try:
        import onnxruntime  # noqa: F401

        _HAVE_MODEL = HAVE_CV
    except Exception:  # noqa: BLE001
        _HAVE_MODEL = False


class SymbolParsing(unittest.TestCase):
    """`_parse_symbol` is the inverse of the TS `tokenSymbol`; get it wrong and every note is wrong."""

    def test_plain_note(self) -> None:
        self.assertEqual(stage2a._parse_symbol("note_C4_4"), ("note", 4, 0, ("C", 0, 4)))

    def test_dotted_note(self) -> None:
        self.assertEqual(stage2a._parse_symbol("note_A4_4d"), ("note", 4, 1, ("A", 0, 4)))

    def test_sharp_and_flat(self) -> None:
        self.assertEqual(stage2a._parse_symbol("note_F#5_8"), ("note", 8, 0, ("F", 1, 5)))
        self.assertEqual(stage2a._parse_symbol("note_Bb3_16"), ("note", 16, 0, ("B", -1, 3)))

    def test_double_accidental(self) -> None:
        self.assertEqual(stage2a._parse_symbol("note_Gbb2_2"), ("note", 2, 0, ("G", -2, 2)))

    def test_rest(self) -> None:
        self.assertEqual(stage2a._parse_symbol("rest_2"), ("rest", 2, 0, None))
        self.assertEqual(stage2a._parse_symbol("rest_4d"), ("rest", 4, 1, None))

    def test_blank_and_garbage(self) -> None:
        self.assertIsNone(stage2a._parse_symbol("<blank>"))
        self.assertIsNone(stage2a._parse_symbol("note_"))
        self.assertIsNone(stage2a._parse_symbol("note_Z4_4"))


class CropReconstruction(unittest.TestCase):
    """The crop box must extend the detected staff to the full-system proportions training used."""

    def test_extends_above_more_than_below(self) -> None:
        # A staff 4 spaces (40 px) tall at y 100..140, unit 10.
        staff = {"yUpper": 100.0, "yLower": 140.0, "yCenter": 120.0, "unit": 10.0, "xLeft": 50.0, "xRight": 950.0}
        box = stage2a._crop_box(staff, img_w=1000, img_h=400)
        staff_h = 40
        # above ~1.6x staffH, below ~0.8x staffH (the measured V15a distribution).
        self.assertEqual(box.top, round(100 - stage2a._ABOVE_STAFF_RATIO * staff_h))
        self.assertEqual(box.left, 50)
        self.assertEqual(box.width, 900)
        expected_bottom = 140 + stage2a._BELOW_STAFF_RATIO * staff_h
        self.assertEqual(box.top + box.height, round(expected_bottom))

    def test_clamps_to_image(self) -> None:
        # A staff near the top edge: the reconstructed top clamps to 0, never negative.
        staff = {"yUpper": 5.0, "yLower": 45.0, "yCenter": 25.0, "unit": 10.0, "xLeft": 0.0, "xRight": 500.0}
        box = stage2a._crop_box(staff, img_w=500, img_h=300)
        self.assertGreaterEqual(box.top, 0)
        self.assertGreaterEqual(box.left, 0)
        self.assertLessEqual(box.left + box.width, 500)
        self.assertLessEqual(box.top + box.height, 300)


class Coordinates(unittest.TestCase):
    """A token's x comes from its CTC column: crop_left + (t+0.5)*cropWidth/T. Beat mapping rides on it."""

    def test_column_to_x_maps_across_the_crop(self) -> None:
        box = stage2a._CropBox(left=100, top=0, width=400, height=100)
        staff = {"yUpper": 0.0, "yLower": 40.0, "yCenter": 20.0, "unit": 10.0, "xLeft": 100.0, "xRight": 500.0}
        noteheads: list = []
        rests: list = []
        # Two notes, columns 0 and 9 of T=10, so x ~ left+20 and left+380.
        seq = [(0, "note_E4_4"), (9, "note_C5_4")]
        stage2a._emit_objects((seq, 10), staff, group=0, box=box, noteheads=noteheads, rests=rests)
        self.assertEqual(len(noteheads), 2)
        cx0 = (noteheads[0]["bbox"][0] + noteheads[0]["bbox"][2]) / 2
        cx1 = (noteheads[1]["bbox"][0] + noteheads[1]["bbox"][2]) / 2
        self.assertAlmostEqual(cx0, 100 + 0.5 * 400 / 10, delta=1.5)
        self.assertAlmostEqual(cx1, 100 + 9.5 * 400 / 10, delta=1.5)
        # x increases left-to-right in emission order — the reading order beat mapping assumes.
        self.assertLess(cx0, cx1)

    def test_pitch_round_trips_through_staff_geometry(self) -> None:
        # E4 sits on the bottom line; its bbox centre y should be ~yLower. C5 is a sixth above.
        box = stage2a._CropBox(left=0, top=0, width=200, height=100)
        staff = {"yUpper": 0.0, "yLower": 40.0, "yCenter": 20.0, "unit": 10.0, "xLeft": 0.0, "xRight": 200.0}
        noteheads: list = []
        stage2a._emit_objects(([(0, "note_E4_4"), (5, "note_C5_4")], 10), staff, 0, box, noteheads, [])
        cy_e4 = (noteheads[0]["bbox"][1] + noteheads[0]["bbox"][3]) / 2
        # E4 → 0 steps above the bottom line → centre at yLower (40).
        self.assertAlmostEqual(cy_e4, 40, delta=1.5)
        cy_c5 = (noteheads[1]["bbox"][1] + noteheads[1]["bbox"][3]) / 2
        # C5 is 5 diatonic steps above E4 → 5 half-spaces (25 px) up from yLower.
        self.assertAlmostEqual(cy_c5, 40 - 5 * (10 / 2), delta=1.5)

    def test_rest_has_no_pitch_and_sits_at_staff_centre(self) -> None:
        box = stage2a._CropBox(left=0, top=0, width=100, height=100)
        staff = {"yUpper": 0.0, "yLower": 40.0, "yCenter": 20.0, "unit": 10.0, "xLeft": 0.0, "xRight": 100.0}
        rests: list = []
        stage2a._emit_objects(([(2, "rest_4")], 5), staff, 0, box, [], rests)
        self.assertEqual(len(rests), 1)
        self.assertEqual(rests[0]["label"], "QUARTER")
        cy = (rests[0]["bbox"][1] + rests[0]["bbox"][3]) / 2
        self.assertAlmostEqual(cy, 20, delta=1.5)

    def test_value_to_label(self) -> None:
        box = stage2a._CropBox(left=0, top=0, width=100, height=100)
        staff = {"yUpper": 0.0, "yLower": 40.0, "yCenter": 20.0, "unit": 10.0, "xLeft": 0.0, "xRight": 100.0}
        noteheads: list = []
        stage2a._emit_objects(([(0, "note_E4_8"), (1, "note_E4_16"), (2, "note_E4_2")], 5), staff, 0, box, noteheads, [])
        self.assertEqual([n["label"] for n in noteheads], ["EIGHTH", "SIXTEENTH", "HALF"])


@unittest.skipUnless(_HAVE_MODEL, "needs onnxruntime + cv2 + a baked model ($SIBEI_BESPOKE_MODEL_DIR)")
class RecognizeSmoke(unittest.TestCase):
    """A full run on a drawn staff: the document is schema-shaped and every coordinate is in bounds.

    Not an accuracy test — a hand-drawn staff is out of the model's training distribution, so the
    decoded notes are arbitrary; what must hold is the *contract* (valid shape, coordinates inside the
    image, the engine's own name and a positive wall-clock).
    """

    def _draw_staff(self) -> str:
        w, h = 1200, 400
        img = np.full((h, w), 255, dtype=np.uint8)
        for y in (150, 170, 190, 210, 230):
            cv2.line(img, (100, y), (1100, y), 0, 2)
        for x in (400, 800):
            cv2.line(img, (x, 150), (x, 230), 0, 3)
        for cx, cy in ((250, 190), (550, 170), (950, 210)):
            cv2.ellipse(img, (cx, cy), (9, 6), 0, 0, 360, 0, -1)
        fd, path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        cv2.imwrite(path, img)
        return path

    def test_document_shape_and_bounds(self) -> None:
        path = self._draw_staff()
        try:
            doc = bespoke.recognize(path, "drawn.png")
        finally:
            os.unlink(path)
        self.assertEqual(doc["schemaVersion"], 2)
        self.assertEqual(doc["source"]["engine"], "bespoke")
        self.assertEqual(doc["source"]["provider"], "cpu")
        self.assertGreaterEqual(doc["source"]["wallClockSeconds"], 0.0)
        # bandTokens may be [] (no chord pair baked, or none detected on this hand-drawn staff) or
        # populated (a full model dir happened to detect *something*) — either is valid; only the shape
        # and coordinate bounds are a contract here (see the module docstring).
        self.assertIsInstance(doc["bandTokens"], list)
        w, h = doc["source"]["imageWidth"], doc["source"]["imageHeight"]
        for obj in doc["noteheads"] + doc["rests"] + doc["barlines"] + doc["bandTokens"]:
            x1, y1, x2, y2 = obj["bbox"]
            self.assertTrue(0 <= x1 <= x2 <= w, f"x out of bounds: {obj['bbox']}")
            self.assertTrue(0 <= y1 <= y2 <= h, f"y out of bounds: {obj['bbox']}")


if __name__ == "__main__":
    unittest.main()
