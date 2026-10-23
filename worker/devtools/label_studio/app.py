"""The labelling studio (ADR-0036, SLICES V27). Dev-only: never imported by product code, never in
CI, never in the shipped worker image — the same posture as `../omr_viz` (EPIC-228), which it sits
beside. See `README.md`.

Slice SIB2-117: pick a PDF page, rasterize it into a scratch directory, run the bespoke engine's
Stage 1, then **correct** what it found — drag, resize, draw and delete regions, give each a kind and
a status — and commit the page. Notes and chords (Stage 2a/2b) are SIB2-118/119.

The editor is an indah ES-module custom component (`modules/region-editor.js`): indah's own
`ImageOverlay` is display-only. Everything else here is ordinary indah.

**No pixel is retained.** The page raster lives in a per-process scratch directory that is removed
at exit; a commit writes coordinates, kinds and statuses under `$SIBEI_REAL_CORPUS_DIR` and nothing
else (ADR-0020's amendment — the real corpus is not rights-cleared). See `labels.py`.
"""

from __future__ import annotations

import atexit
import base64
import io
import os
import shutil
import signal
import sys
import tempfile
from pathlib import Path
from typing import Any

import indah
from indah import Button, Card, Column, Number, Row, Select, Signal, Text

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
sys.path.insert(0, str(REPO_ROOT / "worker"))
sys.path.insert(0, str(HERE))

import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402
from PIL import Image as PILImage  # noqa: E402

import labels  # noqa: E402
import rasterize  # noqa: E402
from sibei_omr.engines.bespoke import layout as bespoke_layout  # noqa: E402

PDF_DIR = Path(os.environ.get("LABEL_STUDIO_PDF_DIR", str(REPO_ROOT / "examples")))
MODEL_DIR = os.environ.get("SIBEI_BESPOKE_MODEL_DIR", str(REPO_ROOT / "out" / "bespoke"))

# The one place a page's pixels exist. 0700 (mkdtemp), removed at exit.
_SCRATCH = Path(tempfile.mkdtemp(prefix="label-studio-"))
atexit.register(shutil.rmtree, _SCRATCH, ignore_errors=True)
# atexit does not run on a bare SIGTERM (a `kill`, a container stop); turn it into a normal exit so the
# raster is still removed.
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

indah.register_component(
    "region-editor",
    module=HERE / "modules" / "region-editor.js",
    events=["change", "select"],
    two_way={"boxes": "change", "selected": "select"},
    fallback="alt",
)


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


# --- region <-> editor box ---------------------------------------------------------------------------
# The editor works in fractions of the image so boxes hold at any zoom; labels are in raster pixels.


def to_box(region: dict, width: int, height: int) -> dict:
    b = region["box"]
    return {"id": region["id"], "kind": region["kind"], "status": region["status"], "x": b["x"] / width, "y": b["y"] / height, "w": b["w"] / width, "h": b["h"] / height}


def to_region(box: dict, width: int, height: int) -> dict:
    return {
        "id": box["id"],
        "kind": box["kind"],
        "status": box["status"],
        "box": {"x": round(box["x"] * width), "y": round(box["y"] * height), "w": round(box["w"] * width), "h": round(box["h"] * height)},
    }


def build_session() -> indah.Session:
    detect_session = _load_detect_session()
    store = labels.CorpusStore()
    pdfs = _list_pdfs()

    picked_pdf: Signal[str] = Signal(pdfs[0] if pdfs else "")
    page_no: Signal[float] = Signal(1)
    boxes: Signal[list] = Signal([])
    selected: Signal[str] = Signal("")
    draw_kind: Signal[str] = Signal("lead-staff")
    sel_kind: Signal[str] = Signal("lead-staff")
    sel_status: Signal[str] = Signal("structure-only")
    image_src: Signal[str] = Signal("")
    message: Signal[str] = Signal("")
    page_state_text: Signal[str] = Signal("")
    saved: Signal[list] = Signal([])  # the boxes as last opened or committed — "dirty" is boxes != saved

    # Everything about the open page that is not a signal.
    page: dict[str, Any] = {"pdf": None, "page": 0, "count": 0, "raster": None, "prelabel": []}

    def is_dirty() -> bool:
        return boxes.peek() != saved.peek()

    def open_page() -> None:
        """Rasterize the picked page into the scratch dir, run Stage 1, and load either the committed
        labels for that page or the engine's pre-label."""
        if not picked_pdf.value:
            return
        if is_dirty():
            message.set("Uncommitted corrections on this page — Commit or Reset to pre-label before leaving.")
            return
        pdf = PDF_DIR / picked_pdf.value
        n = int(page_no.value)
        try:
            info = rasterize.pdf_info(pdf)
            if not 1 <= n <= info.pages:
                message.set(f"Page {n} is out of range (1–{info.pages}).")
                return
            dpi = rasterize.dpi_for(info)
            png = rasterize.render_page(pdf, n, _SCRATCH, dpi)
            img = PILImage.open(png).convert("L")
            staves, barlines = bespoke_layout.detect_layout(np.asarray(img, dtype=np.uint8), np, detect_session)
        except RuntimeError as e:
            message.set(f"Could not open the page: {e}")
            return
        w, h = img.size
        pre = labels.prelabel_regions(staves, barlines)
        committed = store.load_page(pdf, n)
        regions = committed["regions"] if committed else pre
        page.update(pdf=pdf, page=n, count=info.pages, raster={"width": w, "height": h, "dpi": dpi}, prelabel=pre)
        store.mark_prelabelled(pdf, n, info.pages)
        new_boxes = [to_box(r, w, h) for r in regions]

        def apply() -> None:
            image_src.set(_data_uri(img))
            boxes.set(new_boxes)
            saved.set(new_boxes)
            selected.set("")

        indah.batch(apply)
        message.set(f"Opened page {n} of {info.pages} ({w}×{h}px) — {'restored committed labels' if committed else 'engine pre-label'}.")
        refresh_state()

    def refresh_state() -> None:
        if page["pdf"] is not None:
            page_state_text.set(store.page_state(page["pdf"], page["page"]))

    def go(delta: int) -> None:
        page_no.set(max(1, int(page_no.value) + delta))
        open_page()

    def delete_selected() -> None:
        if selected.value:
            boxes.set([b for b in boxes.value if b["id"] != selected.value])
            selected.set("")

    def confirm_unreviewed() -> None:
        n = sum(1 for b in boxes.value if b["status"] == "pre-labelled")
        boxes.set([{**b, "status": "structure-only"} if b["status"] == "pre-labelled" else b for b in boxes.value])
        message.set(f"Confirmed {n} unreviewed regions as structure-only.")

    def reset_to_prelabel() -> None:
        if page["raster"] is None:
            return
        w, h = page["raster"]["width"], page["raster"]["height"]
        new_boxes = [to_box(r, w, h) for r in page["prelabel"]]
        indah.batch(lambda: (boxes.set(new_boxes), selected.set("")))
        message.set("Reset to the engine's pre-label (not yet committed).")

    def commit() -> None:
        if page["pdf"] is None:
            return
        w, h = page["raster"]["width"], page["raster"]["height"]
        regions = [to_region(b, w, h) for b in boxes.value]
        try:
            store.commit_page(page["pdf"], page["page"], page["count"], page["raster"], page["prelabel"], regions)
        except ValueError as e:
            message.set(f"Not committed: {e}")
            return
        saved.set(list(boxes.value))
        unreviewed = sum(1 for r in regions if r["status"] == "pre-labelled")
        note = f" {unreviewed} still pre-labelled — they will be masked from training." if unreviewed else ""
        message.set(f"Committed {len(regions)} regions for page {page['page']}.{note}")
        refresh_state()

    # The selected region's kind/status pickers follow the selection, and edit it. Two effects, one
    # direction each: A reads the selection and sets the pickers (as one batch, so B never sees a
    # half-updated pair); B reads only the pickers and writes the box. Every cross-read is a peek.
    def follow_selection() -> None:
        sel = selected.value
        box = next((b for b in boxes.value if b["id"] == sel), None)
        if box is not None:
            indah.batch(lambda: (sel_kind.set(box["kind"]), sel_status.set(box["status"])))

    def apply_pickers() -> None:
        kind, status = sel_kind.value, sel_status.value
        sel = selected.peek()
        cur = boxes.peek()
        box = next((b for b in cur if b["id"] == sel), None)
        if box is not None and (box["kind"] != kind or box["status"] != status):
            boxes.set([{**b, "kind": kind, "status": status} if b["id"] == sel else b for b in cur])

    indah.effect(follow_selection)
    indah.effect(apply_pickers)

    def caption() -> str:
        if not pdfs:
            return f"No PDFs in `{PDF_DIR}` — set `LABEL_STUDIO_PDF_DIR`."
        by_kind: dict[str, int] = {}
        for b in boxes.value:
            by_kind[b["kind"]] = by_kind.get(b["kind"], 0) + 1
        unrev = sum(1 for b in boxes.value if b["status"] == "pre-labelled")
        kinds = " · ".join(f"{k} **{v}**" for k, v in sorted(by_kind.items())) or "no regions"
        dirty = "  ✏️ **uncommitted**" if boxes.value != saved.value else ""
        return f"page state **{page_state_text.value or '—'}**{dirty}\n\n{kinds} · unreviewed (pre-labelled) **{unrev}**"

    editor = indah.custom(
        "region-editor",
        src=image_src,
        boxes=boxes,
        selected=selected,
        kinds=labels.KINDS,
        newKind=draw_kind,
        alt="PDF page with regions",
    )

    ui = Column(
        children=[
            Text(
                "# Labelling studio\n\nDev-only (ADR-0036). The page is rasterized into a scratch directory and "
                "deleted at exit — **no page image is ever kept**; a commit stores coordinates, kinds and statuses only. "
                "Drag a box to move it, drag a handle to resize, drag empty space to draw; Delete removes; Ctrl-Z undoes; Ctrl-wheel zooms.",
                markdown=True,
            ),
            Card(
                title="Page",
                children=[
                    Row(
                        children=[
                            Select(picked_pdf, options=pdfs or [""], label="PDF"),
                            Number(page_no, min=1, max=999, step=1, label="Page"),
                            Button("Open", open_page),
                            Button("◀ Prev", lambda: go(-1), variant="ghost"),
                            Button("Next ▶", lambda: go(1), variant="ghost"),
                        ]
                    ),
                    Text(caption, markdown=True),
                    Text(lambda: message.value),
                ],
            ),
            Card(
                title="Regions",
                children=[
                    Row(
                        children=[
                            Select(sel_kind, options=labels.KINDS, label="Selected: kind"),
                            Select(sel_status, options=labels.STATUSES, label="Selected: status"),
                            Select(draw_kind, options=labels.KINDS, label="Draw new regions as"),
                            Button("Delete selected", delete_selected, variant="ghost"),
                        ]
                    ),
                    editor,
                    Row(
                        children=[
                            Button("Commit page", commit),
                            Button("Confirm all unreviewed", confirm_unreviewed, variant="tonal"),
                            Button("Reset to pre-label", reset_to_prelabel, variant="ghost", confirm="Discard your corrections to this page?"),
                        ]
                    ),
                ],
            ),
        ]
    )
    if pdfs:
        open_page()
    return indah.Session(ui)


app = indah.create_app(session_factory=build_session)

if __name__ == "__main__":
    indah.launch(app)
