"""Unit + integration tests for the label model and corpus store (ADR-0036 amendment).

Run: .venv/bin/python -m unittest discover -s worker/devtools/label_studio/tests
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import labels  # noqa: E402

RASTER = {"width": 1600, "height": 2200, "dpi": 195}
STAVES = [
    {"xLeft": 100, "xRight": 1500, "yUpper": 300, "yLower": 360, "chordBand": {"x": 100, "y": 200, "w": 1400, "h": 60}},
    {"xLeft": 100, "xRight": 1500, "yUpper": 600, "yLower": 660, "chordBand": None},
]
BARLINES = [{"bbox": [400, 300, 404, 360], "group": 0}, {"bbox": [900, 600, 904, 660], "group": 1}]


def _pre():
    return labels.prelabel_regions(STAVES, BARLINES)


class PrelabelTest(unittest.TestCase):
    def test_kinds_ids_and_status(self):
        pre = _pre()
        self.assertEqual([r["kind"] for r in pre], ["lead-staff", "chord-band", "lead-staff", "barline", "barline"])
        self.assertEqual([r["id"] for r in pre], ["r1", "r2", "r3", "r4", "r5"])
        self.assertTrue(all(r["status"] == "pre-labelled" and r["origin"] == "engine" for r in pre))
        self.assertEqual(pre[0]["box"], {"x": 100, "y": 300, "w": 1400, "h": 60})

    def test_every_pre_label_is_valid(self):
        labels.validate_regions(_pre(), RASTER["width"], RASTER["height"])


class ValidateTest(unittest.TestCase):
    def test_refuses_unknown_kind_status_and_duplicate_ids(self):
        good = _pre()
        for mutate, msg in [
            (lambda r: r[0].update(kind="piano-staff"), "unknown region kind"),
            (lambda r: r[0].update(status="done"), "unknown region status"),
            (lambda r: r[1].update(id="r1"), "duplicated"),
            (lambda r: r[0]["box"].update(w=0), "empty box"),
        ]:
            regions = json.loads(json.dumps(good))
            mutate(regions)
            with self.assertRaisesRegex(ValueError, msg):
                labels.validate_regions(regions, RASTER["width"], RASTER["height"])

    def test_clamps_a_box_dragged_off_the_page(self):
        self.assertEqual(labels.clamp_box({"x": -20, "y": 10, "w": 100, "h": 50}, 1600, 2200), {"x": 0, "y": 10, "w": 80, "h": 50})


class ReconcileTest(unittest.TestCase):
    def test_correction_is_additive(self):
        pre = _pre()
        cur = json.loads(json.dumps(pre))
        cur[0]["box"]["x"] = 150  # move one staff
        cur[0]["status"] = "structure-only"
        recs, removed = labels.reconcile(pre, cur)
        self.assertTrue(recs[0]["edited"])
        # every other region is carried through unchanged, with no `edited` flag
        for before, after in zip(pre[1:], recs[1:]):
            self.assertEqual(after["box"], before["box"])
            self.assertNotIn("edited", after)
        self.assertEqual(removed, [])

    def test_jitter_below_tolerance_is_not_an_edit(self):
        pre = _pre()
        cur = json.loads(json.dumps(pre))
        cur[3]["box"]["x"] += 1
        recs, _ = labels.reconcile(pre, cur)
        self.assertNotIn("edited", recs[3])

    def test_human_regions_and_removed_engine_guesses(self):
        pre = _pre()
        cur = [r for r in json.loads(json.dumps(pre)) if r["id"] != "r5"]
        cur.append({"id": "h1", "kind": "drum-staff", "status": "structure-only", "box": {"x": 10, "y": 900, "w": 500, "h": 60}})
        recs, removed = labels.reconcile(pre, cur)
        self.assertEqual(recs[-1]["origin"], "human")
        self.assertEqual(removed, ["r5"])

    def test_kind_change_is_an_edit(self):
        pre = _pre()
        cur = json.loads(json.dumps(pre))
        cur[2]["kind"] = "drum-staff"
        recs, _ = labels.reconcile(pre, cur)
        self.assertTrue(recs[2]["edited"])


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = labels.CorpusStore(Path(self.tmp.name) / "corpus")
        self.pdf = Path(self.tmp.name) / "Wail.pdf"
        self.pdf.write_bytes(b"%PDF-1.4 not-read-by-the-store")

    def test_commit_round_trips_and_flips_the_page_state(self):
        self.assertEqual(self.store.page_state(self.pdf, 1), "unlabelled")
        self.store.mark_prelabelled(self.pdf, 1, 2)
        self.assertEqual(self.store.page_state(self.pdf, 1), "pre-labelled")
        pre = _pre()
        cur = json.loads(json.dumps(pre))
        cur[0]["status"] = "ignore"
        self.store.commit_page(self.pdf, 1, 2, RASTER, pre, cur)
        self.assertEqual(self.store.page_state(self.pdf, 1), "corrected")
        self.assertEqual(self.store.page_state(self.pdf, 2), "unlabelled")
        saved = self.store.load_page(self.pdf, 1)
        self.assertEqual(saved["raster"], RASTER)
        self.assertEqual(saved["regions"][0]["status"], "ignore")
        self.assertEqual(saved["source"]["page"], 1)

    def test_reopening_a_corrected_page_does_not_demote_it(self):
        pre = _pre()
        self.store.commit_page(self.pdf, 1, 2, RASTER, pre, pre)
        self.store.mark_prelabelled(self.pdf, 1, 2)
        self.assertEqual(self.store.page_state(self.pdf, 1), "corrected")

    def test_a_committed_page_holds_no_image_bytes(self):
        """ADR-0020's amendment holding in a test, byte for byte — not a design intention."""
        pre = _pre()
        self.store.commit_page(self.pdf, 1, 2, RASTER, pre, pre)
        self.assertGreater(len(list((self.store.root).rglob("*.json"))), 1)
        self.assertEqual(labels.scan_for_pixels(self.store.root), [])

    def test_the_pixel_scan_is_not_vacuous(self):
        self.store.root.mkdir(parents=True)
        (self.store.root / "leak.bin").write_bytes(b"\x89PNG\r\n\x1a\n....")
        self.assertEqual([p.name for p in labels.scan_for_pixels(self.store.root)], ["leak.bin"])

    def test_two_pdfs_with_one_name_are_two_songs(self):
        other = Path(self.tmp.name) / "sub" / "Wail.pdf"
        other.parent.mkdir()
        other.write_bytes(b"%PDF-1.4")
        self.assertNotEqual(labels.song_id(self.pdf), labels.song_id(other))

    def test_an_invalid_commit_writes_nothing(self):
        bad = _pre()
        bad[0]["kind"] = "piano-staff"
        with self.assertRaises(ValueError):
            self.store.commit_page(self.pdf, 1, 2, RASTER, _pre(), bad)
        self.assertFalse(self.store.root.exists())


if __name__ == "__main__":
    unittest.main()
