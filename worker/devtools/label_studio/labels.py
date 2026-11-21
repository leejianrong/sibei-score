"""The studio's label model and the durable corpus store (ADR-0036 and its 2026-10-23 amendment).

Standard library only, so the unit tests need neither indah nor onnx.

**A label is structure, never pixels.** Every file written here holds coordinates, kinds, statuses and
text, keyed by `(source PDF path, page number)`. The raster a human corrects against is re-derived
transiently from the maintainer's own PDF (`rasterize.py`) — the real corpus is not rights-cleared, so
ADR-0020's amendment forbids retaining it, and `contains_image_bytes` exists so a test can prove it.

Regions are recorded **wide** (record wide, train narrow, ADR-0038): every region has an open `kind`
and a completion `status`. The exporter (SIB2-108) projects them down:

- `pre-labelled` — an engine guess no human has reviewed. Never trained on as truth: masked.
- `ignore`       — a human said not to train on or score this region: masked.
- `structure-only`, `partial`, `transcribed` — reviewed geometry, used by Stage 1. Stage 2a takes
  only `transcribed` systems (that is later slices' business; this module only stores the word).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1

# The seed taxonomy (ADR-0036 amendment). Open in principle — an unknown kind is refused here, in this
# slice, only so a typo cannot become a silently untrainable class; widening is one line.
KINDS = [
    "lead-staff",
    "accompaniment-staff",
    "drum-staff",
    "chord-band",
    "title",
    "rehearsal-mark",
    "tempo",
    "footer",
    "other",
    "barline",
]
STATUSES = ["pre-labelled", "structure-only", "transcribed", "partial", "ignore"]

# The kinds the Stage-1 detector has a class for today (`BOX_CLASSES`, packages/synth/src/page-boxes.ts).
# Everything else is recorded now and trained on when a class is added — never relabelled.
DETECTOR_CLASS = {"lead-staff": "staff", "chord-band": "chordBand", "title": "title", "barline": "barline"}

PAGE_STATES = ("unlabelled", "pre-labelled", "corrected")

# A box moved or resized by less than this many pixels is not an edit (pointer jitter, rounding).
_EDIT_TOLERANCE_PX = 2


# --- Pre-labelling ---------------------------------------------------------------------------------


def prelabel_regions(staves: list[dict], barlines: list[dict]) -> list[dict]:
    """Stage 1's final objects as regions, in pixels: what `layout.detect_layout` hands the real
    pipeline, so what a human corrects is what the pipeline actually uses. Every region starts
    `pre-labelled` — an unreviewed guess — with a stable id (`r1`, `r2`, ...) the corrections key on."""
    out: list[dict] = []

    def add(kind: str, x: float, y: float, w: float, h: float) -> None:
        out.append(
            {
                "id": f"r{len(out) + 1}",
                "kind": kind,
                "status": "pre-labelled",
                "origin": "engine",
                "box": {"x": round(x), "y": round(y), "w": round(w), "h": round(h)},
            }
        )

    for s in staves:
        add("lead-staff", s["xLeft"], s["yUpper"], s["xRight"] - s["xLeft"], s["yLower"] - s["yUpper"])
        band = s.get("chordBand")
        if band is not None:
            add("chord-band", band["x"], band["y"], band["w"], band["h"])
    for b in barlines:
        x1, y1, x2, y2 = b["bbox"]
        add("barline", x1, y1, x2 - x1, y2 - y1)
    return out


# --- Validation ------------------------------------------------------------------------------------


def validate_regions(regions: list[dict], width: int, height: int) -> None:
    """Refuse what could never be a label. Geometry is clamped, not refused (a human dragged a box a
    little off the page); an unknown kind/status or a duplicate id is a bug and says so."""
    seen: set[str] = set()
    for r in regions:
        if r.get("kind") not in KINDS:
            raise ValueError(f"unknown region kind {r.get('kind')!r} (known: {', '.join(KINDS)})")
        if r.get("status") not in STATUSES:
            raise ValueError(f"unknown region status {r.get('status')!r} (known: {', '.join(STATUSES)})")
        if not isinstance(r.get("id"), str) or not r["id"] or r["id"] in seen:
            raise ValueError(f"region id missing or duplicated: {r.get('id')!r}")
        seen.add(r["id"])
        b = r["box"]
        if not (b["w"] > 0 and b["h"] > 0):
            raise ValueError(f"region {r['id']} has an empty box")
        if b["x"] >= width or b["y"] >= height or b["x"] + b["w"] <= 0 or b["y"] + b["h"] <= 0:
            raise ValueError(f"region {r['id']} lies outside the {width}x{height} page")


def clamp_box(box: dict, width: int, height: int) -> dict:
    x1, y1 = max(0, box["x"]), max(0, box["y"])
    x2, y2 = min(width, box["x"] + box["w"]), min(height, box["y"] + box["h"])
    return {"x": round(x1), "y": round(y1), "w": round(x2 - x1), "h": round(y2 - y1)}


def _same_geometry(a: dict, b: dict) -> bool:
    return all(abs(a[k] - b[k]) <= _EDIT_TOLERANCE_PX for k in ("x", "y", "w", "h"))


def reconcile(prelabel: list[dict], current: list[dict]) -> tuple[list[dict], list[str]]:
    """Mark each current region's provenance against the engine's pre-label, by id.

    A region the engine produced keeps `origin: "engine"` and gains `edited: true` only if a human
    moved it or changed its kind; a region with no engine counterpart is `origin: "human"`. Engine
    regions the human deleted come back as `removed` ids — a recorded negative ("the engine saw a
    staff here and it was not one"), which a plain omission would lose. Correction is additive: an
    untouched region is carried through byte-for-byte."""
    by_id = {r["id"]: r for r in prelabel}
    out: list[dict] = []
    for r in current:
        orig = by_id.get(r["id"])
        rec = {k: r[k] for k in ("id", "kind", "status", "box")}
        if r.get("attrs"):
            rec["attrs"] = r["attrs"]
        if orig is None:
            rec["origin"] = "human"
        else:
            rec["origin"] = "engine"
            if orig["kind"] != r["kind"] or not _same_geometry(orig["box"], r["box"]):
                rec["edited"] = True
        out.append(rec)
    kept = {r["id"] for r in current}
    return out, [r["id"] for r in prelabel if r["id"] not in kept]


# --- The durable store ----------------------------------------------------------------------------


def default_corpus_dir() -> Path:
    return Path(os.environ.get("SIBEI_REAL_CORPUS_DIR", Path.home() / ".local" / "share" / "sbscore" / "real-corpus"))


def song_id(pdf: Path) -> str:
    """A readable, collision-proof id: the file's stem plus a hash of its absolute path, so two
    different `scan.pdf` files in different folders are two different songs."""
    slug = re.sub(r"[^a-z0-9]+", "-", pdf.stem.lower()).strip("-") or "song"
    return f"{slug}-{hashlib.sha1(str(pdf.resolve()).encode()).hexdigest()[:8]}"


def _atomic_write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


class CorpusStore:
    """`$SIBEI_REAL_CORPUS_DIR`: `manifest.json` plus `labels/<song-id>/<page>.json`. Structural data
    only — see the module docstring."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(root) if root is not None else default_corpus_dir()

    @property
    def manifest_path(self) -> Path:
        return self.root / "manifest.json"

    def _page_path(self, pdf: Path, page: int) -> Path:
        return self.root / "labels" / song_id(pdf) / f"{page}.json"

    def read_manifest(self) -> dict:
        try:
            return json.loads(self.manifest_path.read_text())
        except FileNotFoundError:
            return {"schema": SCHEMA_VERSION, "songs": []}

    def _song(self, manifest: dict, pdf: Path, page_count: int) -> dict:
        sid = song_id(pdf)
        for s in manifest["songs"]:
            if s["id"] == sid:
                s["pageCount"] = page_count
                return s
        s = {"id": sid, "title": None, "composer": None, "sourcePdfPath": str(pdf.resolve()), "pageCount": page_count, "pages": {}}
        manifest["songs"].append(s)
        return s

    def page_state(self, pdf: Path, page: int) -> str:
        sid = song_id(pdf)
        for s in self.read_manifest()["songs"]:
            if s["id"] == sid:
                return s["pages"].get(str(page), "unlabelled")
        return "unlabelled"

    def mark_prelabelled(self, pdf: Path, page: int, page_count: int) -> None:
        """Opening an unlabelled page flips it to `pre-labelled` in the manifest (a manifest write
        only — never a label, and never anything derived from the pixels)."""
        m = self.read_manifest()
        song = self._song(m, pdf, page_count)
        if song["pages"].get(str(page)) in (None, "unlabelled"):
            song["pages"][str(page)] = "pre-labelled"
            _atomic_write(self.manifest_path, m)

    def load_page(self, pdf: Path, page: int) -> dict | None:
        try:
            return json.loads(self._page_path(pdf, page).read_text())
        except FileNotFoundError:
            return None

    def commit_page(
        self,
        pdf: Path,
        page: int,
        page_count: int,
        raster: dict,
        prelabel: list[dict],
        regions: list[dict],
        engine: str = "bespoke",
    ) -> dict:
        """Persist one corrected page and flip it to `corrected`. `raster` is `{width, height, dpi}` —
        the grid the pixel boxes live on, so the exporter re-rasterizes at the same scale."""
        validate_regions(regions, raster["width"], raster["height"])
        clamped = [{**r, "box": clamp_box(r["box"], raster["width"], raster["height"])} for r in regions]
        recs, removed = reconcile(prelabel, clamped)
        label = {
            "schema": SCHEMA_VERSION,
            "source": {"pdfPath": str(pdf.resolve()), "page": page},
            "raster": {"width": raster["width"], "height": raster["height"], "dpi": raster["dpi"]},
            "engine": engine,
            "committedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "regions": recs,
            "removed": removed,
        }
        _atomic_write(self._page_path(pdf, page), label)
        m = self.read_manifest()
        song = self._song(m, pdf, page_count)
        song["pages"][str(page)] = "corrected"
        _atomic_write(self.manifest_path, m)
        return label


def contains_image_bytes(blob: bytes) -> bool:
    """True if `blob` looks like it carries a raster: a PNG/JPEG/GIF/PDF signature or an inlined
    `data:image` URI. The acceptance test for ADR-0020's amendment holding, not just intended."""
    return any(sig in blob for sig in (b"\x89PNG", b"\xff\xd8\xff", b"GIF8", b"%PDF-", b"data:image"))


def scan_for_pixels(root: Path) -> list[Path]:
    """Every file under `root` that looks like it carries image bytes (expected: none)."""
    if not root.exists():
        return []
    return [p for p in root.rglob("*") if p.is_file() and contains_image_bytes(p.read_bytes())]
