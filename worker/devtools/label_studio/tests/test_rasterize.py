"""Unit tests for PDF ingestion. Standalone `unittest`, like the rest of worker/ — not in the Node CI.

Run: python -m unittest discover -s worker/devtools/label_studio/tests
"""

import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import rasterize  # noqa: E402


def _scan_pdf(path: Path, pages: int) -> None:
    """An image-only PDF (no text layer), like a scan or screenshot."""
    imgs = [Image.new("L", (850, 1100), 255) for _ in range(pages)]
    for i, im in enumerate(imgs):
        ImageDraw.Draw(im).rectangle((100, 100, 300 + 50 * i, 200), fill=0)
    imgs[0].save(path, "PDF", resolution=100.0, save_all=True, append_images=imgs[1:])


class RasterizeTest(unittest.TestCase):
    def test_page_count_size_and_resolution(self):
        with tempfile.TemporaryDirectory() as d:
            pdf = Path(d) / "scan.pdf"
            _scan_pdf(pdf, 2)
            info = rasterize.pdf_info(pdf)
            self.assertEqual(info.pages, 2)
            png = rasterize.render_page(pdf, 2, Path(d))
            w, h = Image.open(png).size
            self.assertAlmostEqual(w * h / 1e6, rasterize.TARGET_MEGAPIXELS, delta=0.3)
            self.assertAlmostEqual(w / h, 850 / 1100, places=2)

    def test_scan_has_no_text_layer(self):
        with tempfile.TemporaryDirectory() as d:
            pdf = Path(d) / "scan.pdf"
            _scan_pdf(pdf, 1)
            self.assertFalse(rasterize.has_text_layer(pdf, 1))

    def test_page_out_of_range(self):
        with tempfile.TemporaryDirectory() as d:
            pdf = Path(d) / "scan.pdf"
            _scan_pdf(pdf, 1)
            with self.assertRaises(ValueError):
                rasterize.render_page(pdf, 2, Path(d))

    def test_dpi_scales_with_page_size(self):
        letter = rasterize.PdfInfo(1, 612, 792)
        a4 = rasterize.PdfInfo(1, 595.3, 841.9)
        self.assertAlmostEqual(rasterize.dpi_for(letter), 198, delta=2)
        self.assertAlmostEqual(rasterize.dpi_for(a4), 195, delta=2)


if __name__ == "__main__":
    unittest.main()
