"""PDF ingestion for the labelling studio (ADR-0036 part 1, SLICES V27).

Every page is rasterized, always — a lead-sheet PDF's vector paths are glyph outlines, not a
semantic layer, so there is no fast path around recognition (ADR-0018's reasoning, applied to
dev tooling). Rasterizing shells out to poppler.

**No pixel is retained.** The caller owns a scratch directory and deletes it; nothing here writes
anywhere else. That is ADR-0020's amendment holding in code: the corpus is not rights-cleared, so a
page image may live only for the length of a labelling session.

Dependency-free beyond the standard library, so the unit tests need no indah/onnx.
"""

from __future__ import annotations

import math
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

# oemer's own normalisation target (ADR-0023): the recognisers were tuned on pages about this big.
TARGET_MEGAPIXELS = 3.67


@dataclass(frozen=True)
class PdfInfo:
    pages: int
    width_pt: float
    height_pt: float


def _run(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    except FileNotFoundError as e:
        raise RuntimeError(f"{cmd[0]} not found — install poppler-utils (apt) / poppler (brew)") from e
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"{cmd[0]} failed on the PDF: {e.stderr.strip() or e}") from e


def pdf_info(pdf: Path) -> PdfInfo:
    out = _run(["pdfinfo", str(pdf)])
    pages = re.search(r"^Pages:\s+(\d+)", out, re.M)
    size = re.search(r"^Page size:\s+([\d.]+) x ([\d.]+) pts", out, re.M)
    if not pages or not size:
        raise RuntimeError(f"pdfinfo gave no page count/size for {pdf}")
    return PdfInfo(int(pages.group(1)), float(size.group(1)), float(size.group(2)))


def dpi_for(info: PdfInfo, megapixels: float = TARGET_MEGAPIXELS) -> int:
    """The render resolution that lands a page near `megapixels`, so a letter page and an A4
    screenshot reach the recognisers at the same scale rather than at one fixed dpi."""
    area_in2 = (info.width_pt / 72.0) * (info.height_pt / 72.0)
    return max(72, round(math.sqrt(megapixels * 1_000_000 / area_in2)))


def has_text_layer(pdf: Path, page: int) -> bool:
    """Whether the page carries extractable text — a bonus pre-label seed for title/composer, never
    a substitute for visual annotation (Q86). A scan or screenshot returns a few stray bytes."""
    text = _run(["pdftotext", "-f", str(page), "-l", str(page), str(pdf), "-"])
    return len(text.strip()) >= 20


def render_page(pdf: Path, page: int, out_dir: Path, dpi: int | None = None) -> Path:
    """Rasterize 1-indexed `page` of `pdf` to a grayscale PNG in `out_dir` and return its path."""
    info = pdf_info(pdf)
    if not 1 <= page <= info.pages:
        raise ValueError(f"page {page} out of range 1..{info.pages}")
    stem = out_dir / f"page-{page}"
    _run(["pdftoppm", "-f", str(page), "-l", str(page), "-r", str(dpi or dpi_for(info)), "-gray", "-png", "-singlefile", str(pdf), str(stem)])
    return stem.with_suffix(".png")
