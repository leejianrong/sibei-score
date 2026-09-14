"""Tests for the batch recogniser (KAN-1379, the ADR-0032 on-pod eval path).

Standalone, like the rest of ``worker/`` — outside the pnpm workspace and not in the Node CI
(ADR-0005). Run with ``python -m unittest`` from ``worker/`` in the venv. No oemer, no weights, and
no minutes: ``run_batch`` takes an injected ``recognize_fn`` (the same seam ``server.serve`` has), so
the batch's own logic — image discovery, per-image JSON output, the stem-preserving naming, and the
per-image failure isolation — is exercised without the heavy recognition behind it.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from sibei_omr.batch import list_images, run_batch


def _doc_for(name: str) -> dict:
    return {"schemaVersion": 2, "source": {"imagePath": name}, "noteheads": [name]}


class BatchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.in_dir = tempfile.mkdtemp(prefix="sibei-batch-in-")
        self.out_dir = tempfile.mkdtemp(prefix="sibei-batch-out-")

    def _write_image(self, name: str) -> None:
        with open(os.path.join(self.in_dir, name), "wb") as fh:
            fh.write(b"not-a-real-image")

    def test_lists_only_images_in_stable_order(self) -> None:
        for name in ["b.png", "a.jpg", "notes.txt", "c.jpeg"]:
            self._write_image(name)
        self.assertEqual(list_images(self.in_dir), ["a.jpg", "b.png", "c.jpeg"])

    def test_writes_one_document_per_image_named_by_stem(self) -> None:
        self._write_image("seed-0_bars-8_clean.png")
        self._write_image("seed-1_bars-8_heavy.jpg")

        seen = []
        result = run_batch(self.in_dir, self.out_dir, lambda path, name: (seen.append(name) or _doc_for(name)))

        self.assertEqual(result.failed, [])
        self.assertEqual(sorted(result.ok), ["seed-0_bars-8_clean.png", "seed-1_bars-8_heavy.jpg"])
        # The stem is preserved regardless of extension: the .png and the .jpg both drop their suffix.
        self.assertTrue(os.path.exists(os.path.join(self.out_dir, "seed-0_bars-8_clean.omr.json")))
        self.assertTrue(os.path.exists(os.path.join(self.out_dir, "seed-1_bars-8_heavy.omr.json")))
        # The document written is exactly what the recogniser returned (the wire shape, unchanged).
        with open(os.path.join(self.out_dir, "seed-0_bars-8_clean.omr.json"), encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertEqual(doc["source"]["imagePath"], "seed-0_bars-8_clean.png")

    def test_out_dir_is_created_if_absent(self) -> None:
        self._write_image("a.png")
        nested = os.path.join(self.out_dir, "nested", "docs")
        run_batch(self.in_dir, nested, lambda path, name: _doc_for(name))
        self.assertTrue(os.path.exists(os.path.join(nested, "a.omr.json")))

    def test_one_bad_image_does_not_abort_the_batch(self) -> None:
        for name in ["good1.png", "bad.png", "good2.png"]:
            self._write_image(name)

        def recognize(path, name):
            if name == "bad.png":
                raise RuntimeError("oemer fell over on this page")
            return _doc_for(name)

        result = run_batch(self.in_dir, self.out_dir, recognize)

        self.assertEqual(sorted(result.ok), ["good1.png", "good2.png"])
        self.assertEqual(len(result.failed), 1)
        self.assertEqual(result.failed[0][0], "bad.png")
        self.assertIn("oemer fell over", result.failed[0][1])
        # The successful pages are written; the failed one is not.
        self.assertTrue(os.path.exists(os.path.join(self.out_dir, "good1.omr.json")))
        self.assertFalse(os.path.exists(os.path.join(self.out_dir, "bad.omr.json")))


if __name__ == "__main__":
    unittest.main()
