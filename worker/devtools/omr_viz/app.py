"""Qualitative viewer for the bespoke OMR engine's Stage 1 layout detector (EPIC-228,
Milestone A / KAN-1505).

Dev-only. Never imported by product code, never in CI, never in the shipped worker image —
mirrors the posture of `worker/visualize_detect.py` and `tools/runpod` (ADR-0005/0024). It
imports `sibei_omr.engines.bespoke` directly via `sys.path`, not an editable install of the
`sibei-omr` package, so it never pulls in oemer/PaddleOCR — see `devtools/README.md` for setup.

Run it:

    cd worker/devtools/omr_viz
    uv venv --python 3.11
    uv pip install -e /home/jianlee/projects/abang-ai/indah-python-ui
    uv pip install -e .
    SIBEI_BESPOKE_MODEL_DIR=$PWD/../../../out/bespoke python app.py

Then open the printed URL. Pick a corpus image (generate one with
`pnpm eval --dump-corpus out/viz-corpus --seeds 6 --bars 16`, run from the repo root) or
upload a real photo, and drag the score threshold to see Stage 1's staff/barline/chordBand/
title detections update live — this is also where the V17e-suspected indah gaps (image
zoom/pan, large-image payload cost) get a real workout; see KAN-1505 before filing an issue.
"""

from __future__ import annotations

import base64
import io
import os
import sys
from pathlib import Path
from typing import Any

import indah
from indah import (
    Card,
    Column,
    ImageOverlay,
    Radio,
    Row,
    Select,
    Signal,
    Slider,
    Text,
    Upload,
    UploadedFile,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_DIR = REPO_ROOT / "worker"
sys.path.insert(0, str(WORKER_DIR))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402
from PIL import Image as PILImage  # noqa: E402

from sibei_omr.engines.bespoke.detect_config import IN_H, IN_W  # noqa: E402
from sibei_omr.engines.bespoke.detect_decode import decode  # noqa: E402

CLASSES = ["staff", "barline", "chordBand", "title"]
COLORS = {
    "staff": "#2f6fe0",
    "barline": "#e0533a",
    "chordBand": "#12a150",
    "title": "#a12fd0",
}

MODEL_DIR = os.environ.get("SIBEI_BESPOKE_MODEL_DIR", str(REPO_ROOT / "out" / "bespoke"))
CORPUS_DIR = Path(os.environ.get("OMR_VIZ_CORPUS_DIR", str(REPO_ROOT / "out" / "viz-corpus")))
IMAGE_EXTS = (".png", ".jpg", ".jpeg")


def _load_session() -> Any:
    path = os.path.join(MODEL_DIR, "detect.onnx")
    if not os.path.isfile(path):
        raise RuntimeError(
            f"Stage-1 detector not found at {path}. Fetch it first: "
            f"`python worker/fetch_bespoke.py --dir {MODEL_DIR}`, or set $SIBEI_BESPOKE_MODEL_DIR."
        )
    return ort.InferenceSession(path, providers=["CPUExecutionProvider"])


def _list_corpus_images() -> list[str]:
    if not CORPUS_DIR.is_dir():
        return []
    return sorted(p.name for p in CORPUS_DIR.iterdir() if p.suffix.lower() in IMAGE_EXTS)


def _resize(gray: np.ndarray, out_w: int, out_h: int) -> np.ndarray:
    return cv2.resize(gray, (out_w, out_h), interpolation=cv2.INTER_AREA)


def _png_data_uri(pil_image: PILImage.Image) -> str:
    """Always re-encode as PNG so the data: URI's mime is honest (a corpus sample may be a
    degraded .jpg; ImageOverlay expects a correctly-labelled source, not sniffed bytes)."""
    buf = io.BytesIO()
    pil_image.convert("RGB").save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def build_session() -> indah.Session:
    session = _load_session()
    corpus_files = _list_corpus_images()

    active_source: Signal[str] = Signal("corpus" if corpus_files else "upload")
    picked_file: Signal[str] = Signal(corpus_files[0] if corpus_files else "")
    uploaded_bytes: Signal[bytes | None] = Signal(None)
    uploaded_name: Signal[str] = Signal("")
    threshold: Signal[float] = Signal(0.3)

    async def on_upload(file: UploadedFile) -> None:
        uploaded_bytes.set(file.data)
        uploaded_name.set(file.filename)
        active_source.set("upload")

    def current_pil_image() -> PILImage.Image | None:
        if active_source.value == "upload" and uploaded_bytes.value is not None:
            return PILImage.open(io.BytesIO(uploaded_bytes.value)).convert("L")
        if active_source.value == "corpus" and picked_file.value:
            path = CORPUS_DIR / picked_file.value
            if path.is_file():
                return PILImage.open(path).convert("L")
        return None

    def image_src() -> str:
        img = current_pil_image()
        return _png_data_uri(img) if img is not None else ""

    def detections() -> list[dict]:
        img = current_pil_image()
        if img is None:
            return []
        w, h = img.width, img.height
        arr = np.asarray(img, dtype=np.uint8)
        small = _resize(arr, IN_W, IN_H)
        x = ((small.astype(np.float32) / 255.0 - 0.5) / 0.5)[np.newaxis, np.newaxis, :, :]
        out = session.run(None, {session.get_inputs()[0].name: x})[0][0]
        dets = decode(out, orig_w=w, orig_h=h, thresh=threshold.value)
        boxes = []
        for d in dets:
            cls = CLASSES[d["cls"]]
            boxes.append(
                {
                    "x": d["x"] / w,
                    "y": d["y"] / h,
                    "w": d["w"] / w,
                    "h": d["h"] / h,
                    "label": f"{cls} {d['score']:.2f}",
                    "color": COLORS[cls],
                    "score": d["score"],
                }
            )
        return boxes

    def counts_text() -> str:
        img = current_pil_image()
        if img is None:
            return "_No image selected — pick a corpus sample or upload a photo._"
        by_class: dict[str, int] = {c: 0 for c in CLASSES}
        for box in detections():
            cls = box["label"].split(" ")[0]
            by_class[cls] = by_class.get(cls, 0) + 1
        parts = ", ".join(f"**{c}**: {n}" for c, n in by_class.items())
        return f"{img.width}×{img.height}px — {parts}"

    def corpus_hint() -> str:
        if corpus_files:
            return ""
        return (
            f"_No corpus images at `{CORPUS_DIR}`. Generate some from the repo root:_ "
            "`pnpm eval --dump-corpus out/viz-corpus --seeds 6 --bars 16`"
        )

    inputs = Card(
        title="Input",
        children=[
            Radio(active_source, options=["corpus", "upload"], label="Source"),
            Select(picked_file, options=corpus_files or [""], label="Corpus image"),
            Text(corpus_hint, markdown=True),
            Upload(on_upload, accept="image/*", label="Upload a real photo"),
            Text(lambda: f"Active: {uploaded_name.value}" if active_source.value == "upload" and uploaded_name.value else ""),
            Slider(threshold, min=0.05, max=0.9, step=0.01, label="Stage-1 score threshold"),
        ],
    )

    output = Card(
        title="Stage 1 — layout detection",
        children=[
            ImageOverlay(image_src, boxes=detections, alt="page with Stage-1 detections"),
            Text(counts_text, markdown=True),
        ],
    )

    page = Column(
        children=[
            Text(
                "# OMR pipeline viewer — Stage 1 (layout detection)\n\n"
                "Dev-only qualitative check for the bespoke engine (EPIC-228). "
                "See `docs/omr-pipeline.md` for the pipeline this stage belongs to.",
                markdown=True,
            ),
            Row(children=[inputs, output]),
        ]
    )

    return indah.Session(page)


app = indah.create_app(session_factory=build_session)

if __name__ == "__main__":
    indah.launch(app)
