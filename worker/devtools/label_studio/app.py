"""The labelling studio (ADR-0036, SLICES V27). Dev-only: never imported by product code, never in
CI, never in the shipped worker image — the same posture as `../omr_viz` (EPIC-228), which it sits
beside. See `README.md`.

This slice (KAN SIB2-116) is read-only: pick a PDF page, rasterize it into a scratch directory, run
the bespoke engine's Stage 1 over it and overlay what it found. Correcting and committing labels
are the next slices (SIB2-117 onwards).

**No pixel is retained.** The page raster lives in a per-process scratch directory that is removed
at exit; nothing is ever written next to the PDF or into the repo (ADR-0020's amendment — the real
corpus is not rights-cleared).
"""

from __future__ import annotations

import atexit
import base64
import io
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

import indah
from indah import Card, Column, ImageOverlay, Number, Row, Select, Signal, Text

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
sys.path.insert(0, str(REPO_ROOT / "worker"))
sys.path.insert(0, str(HERE))

import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402
from PIL import Image as PILImage  # noqa: E402

import rasterize  # noqa: E402
from sibei_omr.engines.bespoke import layout as bespoke_layout  # noqa: E402

PDF_DIR = Path(os.environ.get("LABEL_STUDIO_PDF_DIR", str(REPO_ROOT / "examples")))
MODEL_DIR = os.environ.get("SIBEI_BESPOKE_MODEL_DIR", str(REPO_ROOT / "out" / "bespoke"))

COLORS = {"staff": "#2f6fe0", "barline": "#e0533a", "chordBand": "#12a150"}

# The one place a page's pixels exist. 0700 (mkdtemp), removed at exit.
_SCRATCH = Path(tempfile.mkdtemp(prefix="label-studio-"))
atexit.register(shutil.rmtree, _SCRATCH, ignore_errors=True)


def _list_pdfs() -> list[str]:
    return sorted(p.name for p in PDF_DIR.glob("*.pdf")) if PDF_DIR.is_dir() else []


def _load_detect_session() -> Any:
    path = os.path.join(MODEL_DIR, "detect.onnx")
    if not os.path.isfile(path):
        raise RuntimeError(f"Stage-1 detector not found at {path}. Fetch it: `python worker/fetch_bespoke.py --dir {MODEL_DIR}`.")
    return ort.InferenceSession(path, providers=["CPUExecutionProvider"])


def _data_uri(img: PILImage.Image) -> str:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


def prelabel_boxes(staves: list[dict], barlines: list[dict]) -> list[dict]:
    """Stage 1's final objects as `{cls, x, y, w, h}` pixel boxes — the same set `layout.detect_layout`
    hands the real pipeline, so what is corrected later is what the pipeline actually uses."""
    boxes: list[dict] = []
    for s in staves:
        boxes.append({"cls": "staff", "x": s["xLeft"], "y": s["yUpper"], "w": s["xRight"] - s["xLeft"], "h": s["yLower"] - s["yUpper"]})
        band = s.get("chordBand")
        if band is not None:
            boxes.append({"cls": "chordBand", "x": band["x"], "y": band["y"], "w": band["w"], "h": band["h"]})
    for b in barlines:
        x1, y1, x2, y2 = b["bbox"]
        boxes.append({"cls": "barline", "x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1})
    return boxes


def build_session() -> indah.Session:
    detect_session = _load_detect_session()
    pdfs = _list_pdfs()

    picked_pdf: Signal[str] = Signal(pdfs[0] if pdfs else "")
    page_no: Signal[float] = Signal(1)

    def page_count() -> int:
        if not picked_pdf.value:
            return 0
        return rasterize.pdf_info(PDF_DIR / picked_pdf.value).pages

    page_count_computed = indah.computed(page_count)

    def rendered() -> "tuple[PILImage.Image, list[dict]] | None":
        """Rasterize the picked page (scratch dir only) and run Stage 1 once for the overlay,
        the counts and the table — memoized per (pdf, page)."""
        if not picked_pdf.value:
            return None
        n = int(page_no.value)
        if not 1 <= n <= page_count_computed.value:
            return None
        png = rasterize.render_page(PDF_DIR / picked_pdf.value, n, _SCRATCH)
        img = PILImage.open(png).convert("L")
        staves, barlines = bespoke_layout.detect_layout(np.asarray(img, dtype=np.uint8), np, detect_session)
        return img, prelabel_boxes(staves, barlines)

    rendered_computed = indah.computed(rendered)

    def image_src() -> str:
        r = rendered_computed.value
        return _data_uri(r[0]) if r else ""

    def overlay_boxes() -> list[dict]:
        r = rendered_computed.value
        if not r:
            return []
        img, boxes = r
        return [
            {"x": _clamp01(b["x"] / img.width), "y": _clamp01(b["y"] / img.height), "w": _clamp01(b["w"] / img.width), "h": _clamp01(b["h"] / img.height), "color": COLORS[b["cls"]]}
            for b in boxes
        ]

    def caption() -> str:
        if not pdfs:
            return f"No PDFs in `{PDF_DIR}` — set `LABEL_STUDIO_PDF_DIR`."
        r = rendered_computed.value
        n = page_count_computed.value
        if not r:
            return f"Page out of range (1–{n})."
        img, boxes = r
        counts = {c: sum(1 for b in boxes if b["cls"] == c) for c in COLORS}
        text = "yes" if rasterize.has_text_layer(PDF_DIR / picked_pdf.value, int(page_no.value)) else "no"
        return (
            f"`{picked_pdf.value}` page **{int(page_no.value)}** of {n} · {img.width}×{img.height}px · text layer: {text}\n\n"
            f"🟦 staff **{counts['staff']}** · 🟥 barline **{counts['barline']}** · 🟩 chordBand **{counts['chordBand']}**"
        )

    page = Column(
        children=[
            Text(
                "# Labelling studio\n\nDev-only (ADR-0036). Pages are rasterized into a scratch directory and "
                "deleted at exit — **no page image is ever kept**. This slice is read-only: Stage 1 pre-label.",
                markdown=True,
            ),
            Card(
                title="Page",
                children=[
                    Row(children=[Select(picked_pdf, options=pdfs or [""], label="PDF"), Number(page_no, min=1, max=999, step=1, label="Page")]),
                    Text(caption, markdown=True),
                    ImageOverlay(image_src, boxes=overlay_boxes, alt="PDF page with Stage-1 pre-label", label_mode="hover"),
                ],
            ),
        ]
    )
    return indah.Session(page)


app = indah.create_app(session_factory=build_session)

if __name__ == "__main__":
    indah.launch(app)
