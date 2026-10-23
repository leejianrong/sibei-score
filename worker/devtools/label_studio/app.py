"""The labelling studio (ADR-0036, SLICES V27). Dev-only: never imported by product code, never in
CI, never in the shipped worker image — the same posture as `../omr_viz` (EPIC-228), which it sits
beside. See `README.md`.

SIB2-116/117/126: pick a PDF page, rasterize it into a scratch directory, run the bespoke engine's
Stage 1, then **correct** what it found — drag, resize, draw and delete regions, give each a kind and
a status — and commit the page. Notes and chords (Stage 2a/2b) are SIB2-118/119.

The screen is one indah ES-module custom component (`modules/workbench.js`): indah's own
`ImageOverlay` is display-only, and the review loop (Tab / Enter / 1-6) needs a keyboard-first canvas.
Python owns everything that is not drawing: the PDF, the engine, the label store, and what is dirty.
The Material 3 roles come from `m3_theme.py`.

**No pixel is retained.** The page raster lives in a per-process scratch directory that is removed
at exit; a commit writes coordinates, kinds and statuses under `$SIBEI_REAL_CORPUS_DIR` and nothing
else (ADR-0020's amendment — the real corpus is not rights-cleared). See `labels.py`.
"""

from __future__ import annotations

import asyncio
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
from indah import Column, Signal

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
sys.path.insert(0, str(REPO_ROOT / "worker"))
sys.path.insert(0, str(HERE))

import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402
from PIL import Image as PILImage  # noqa: E402

import labels  # noqa: E402
import rasterize  # noqa: E402
from m3_theme import studio_theme  # noqa: E402
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
    "studio-workbench",
    module=HERE / "modules" / "workbench.js",
    events=["change", "select", "commit", "nav", "confirm-all", "reset", "action"],
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
    box = {"id": region["id"], "kind": region["kind"], "status": region["status"], "x": b["x"] / width, "y": b["y"] / height, "w": b["w"] / width, "h": b["h"] / height}
    if region.get("system") is not None:
        box["system"] = region["system"]
    return box


def to_region(box: dict, width: int, height: int) -> dict:
    r = {
        "id": box["id"],
        "kind": box["kind"],
        "status": box["status"],
        "box": {"x": round(box["x"] * width), "y": round(box["y"] * height), "w": round(box["w"] * width), "h": round(box["h"] * height)},
    }
    if box.get("system") is not None:
        r["system"] = box["system"]
    return r


def _recognise(pdf: Path, n: int, detect_session: Any) -> tuple[PILImage.Image, int, int, list[dict]]:
    """Blocking work, run off the event loop: rasterize one page and run Stage 1 over it."""
    info = rasterize.pdf_info(pdf)
    if not 1 <= n <= info.pages:
        raise ValueError(f"page {n} is out of range (1 to {info.pages})")
    dpi = rasterize.dpi_for(info)
    png = rasterize.render_page(pdf, n, _SCRATCH, dpi)
    img = PILImage.open(png).convert("L")
    staves, barlines = bespoke_layout.detect_layout(np.asarray(img, dtype=np.uint8), np, detect_session)
    return img, info.pages, dpi, labels.prelabel_regions(staves, barlines)


async def build_session() -> indah.Session:
    detect_session = _load_detect_session()
    store = labels.CorpusStore()
    pdfs = _list_pdfs()

    picked_pdf: Signal[str] = Signal(pdfs[0] if pdfs else "")
    cur_page: Signal[int] = Signal(0)
    page_count: Signal[int] = Signal(0)
    page_state: Signal[str] = Signal("")
    busy: Signal[bool] = Signal(False)
    boxes: Signal[list] = Signal([])
    selected: Signal[str] = Signal("")
    image_src: Signal[str] = Signal("")
    saved: Signal[list] = Signal([])  # the boxes as last opened or committed — "dirty" is boxes != saved
    toast: Signal[dict | None] = Signal(None)
    toast_n = [0]

    # Everything about the open page that is not a signal.
    page: dict[str, Any] = {"pdf": None, "raster": None, "prelabel": []}

    def say(text: str, action: tuple[str, str] | None = None) -> None:
        toast_n[0] += 1
        toast.set({"id": toast_n[0], "text": text, "action": {"label": action[0], "value": action[1]} if action else None})

    def info_dict() -> dict:
        empty = "" if pdfs else f"No PDFs in {PDF_DIR}. Put some there, or set LABEL_STUDIO_PDF_DIR."
        return {
            "file": picked_pdf.value,
            "pdfs": pdfs,
            "page": cur_page.value,
            "count": page_count.value,
            "state": page_state.value,
            "dirty": boxes.value != saved.value,
            "busy": busy.value,
            "empty": empty,
        }

    info = indah.computed(info_dict)

    async def open_page(pdf_name: str, n: int) -> None:
        """Rasterize the page into the scratch dir, run Stage 1 off the event loop, and load either
        the committed labels for that page or the engine's pre-label."""
        if busy.value or not pdf_name:
            return
        pdf = PDF_DIR / pdf_name
        busy.set(True)
        await asyncio.sleep(0)  # let the busy indicator reach the browser before the heavy work
        try:
            img, count, dpi, pre = await asyncio.to_thread(_recognise, pdf, n, detect_session)
        except (RuntimeError, ValueError) as e:
            busy.set(False)
            say(f"Could not open the page: {e}")
            return
        w, h = img.size
        committed = store.load_page(pdf, n)
        regions = committed["regions"] if committed else pre
        page.update(pdf=pdf, raster={"width": w, "height": h, "dpi": dpi}, prelabel=pre)
        store.mark_prelabelled(pdf, n, count)
        new_boxes = [to_box(r, w, h) for r in regions]

        def apply() -> None:
            image_src.set(_data_uri(img))
            boxes.set(new_boxes)
            saved.set(new_boxes)
            selected.set("")
            picked_pdf.set(pdf_name)
            cur_page.set(n)
            page_count.set(count)
            page_state.set(store.page_state(pdf, n))
            busy.set(False)

        indah.batch(apply)
        if committed:
            say(f"Restored your committed labels for page {n}.")

    def commit() -> bool:
        if page["pdf"] is None:
            return False
        w, h = page["raster"]["width"], page["raster"]["height"]
        regions = [to_region(b, w, h) for b in boxes.value]
        try:
            store.commit_page(page["pdf"], cur_page.value, page_count.value, page["raster"], page["prelabel"], regions)
        except ValueError as e:
            say(f"Not committed: {e}")
            return False
        saved.set(list(boxes.value))
        page_state.set(store.page_state(page["pdf"], cur_page.value))
        unreviewed = sum(1 for r in regions if r["status"] == "pre-labelled")
        tail = f" {unreviewed} still unreviewed will be kept out of training." if unreviewed else ""
        nxt = ("Next page", "next-page") if cur_page.value < page_count.value else None
        say(f"Committed {len(regions)} regions for page {cur_page.value}.{tail}", nxt)
        return True

    async def on_nav(d: dict) -> None:
        """Navigation requests come from the workbench, which has already asked about uncommitted work."""
        mode = d.get("mode", "go")
        if boxes.value != saved.value:
            if mode == "commit":
                if not commit():
                    return
            elif mode == "discard":
                saved.set(list(boxes.value))
            else:
                say("Commit or discard your corrections before leaving this page.")
                return
        pdf_name = d.get("pdf") or picked_pdf.value
        n = int(d["page"]) if d.get("page") is not None else cur_page.value + int(d.get("delta", 0))
        await open_page(pdf_name, n)

    def on_confirm_all(_: Any = None) -> None:
        n = sum(1 for b in boxes.value if b["status"] == "pre-labelled")
        boxes.set([{**b, "status": "structure-only"} if b["status"] == "pre-labelled" else b for b in boxes.value])
        say(f"Confirmed {n} regions.")

    def on_reset(_: Any = None) -> None:
        if page["raster"] is None:
            return
        w, h = page["raster"]["width"], page["raster"]["height"]
        indah.batch(lambda: (boxes.set([to_box(r, w, h) for r in page["prelabel"]]), selected.set("")))
        say("Reset to the engine's pre-label. Nothing is committed until you commit.")

    async def on_action(d: dict) -> None:
        if d.get("value") == "next-page":
            await on_nav({"delta": 1, "mode": "go"})

    editor = indah.custom(
        "studio-workbench",
        src=image_src,
        boxes=boxes,
        selected=selected,
        kinds=labels.KINDS,
        statuses=labels.STATUSES,
        info=info,
        toast=toast,
        alt="PDF page with regions",
        on_commit=lambda _d: commit(),
        on_nav=on_nav,
        on_confirm_all=on_confirm_all,
        on_reset=on_reset,
        on_action=on_action,
    )
    if pdfs:
        await open_page(picked_pdf.value, 1)
    return indah.Session(Column(children=[editor]))


app = indah.create_app(session_factory=build_session, theme=studio_theme(), max_width="none", title="Labelling studio", title_suffix=" · sibei-score")

if __name__ == "__main__":
    indah.launch(app)
