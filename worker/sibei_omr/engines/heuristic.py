"""A dependency-light heuristic OMR engine (V13c).

OpenCV image processing only — no ML weights, no tensorflow/onnxruntime, low RAM — so it runs the
whole photo → draft → PDF flow, and ``make eval``, on a small host where oemer's ~7 GB dual-U-Net
model is OOM-killed (V12). It emits the **same** OmrDocument shape oemer does
(``packages/model/src/omr.ts``), so ``mapOmrToScore`` and everything downstream consume it with no
engine-specific branch (ADR-0005) — that shared boundary is the whole point of the seam.

**What it is and is not.** This is dev/test scaffolding and the seed of the bespoke direction
(ADR-0031), NOT the trained bespoke recogniser V15/V16 will build, and it earns **no** default swap —
that is decided on the V12 harness (ADR-0020), never by fiat. Its accuracy is deliberately modest:

- **Staves** — found by extracting long horizontal runs and grouping the resulting lines into staves
  of five. Coordinates (``yUpper``/``yLower``/``unitSize``) drive the mapper's treble-clef pitch
  geometry, so getting the staff right is what matters most.
- **Barlines** — tall vertical runs spanning most of a staff's height (a stem is shorter, so height
  discriminates).
- **Noteheads** — elliptical blobs left after the staff lines and vertical runs are removed, filtered
  by size against the staff's unit. Every head is labelled ``QUARTER``: this engine reads pitch (from
  geometry, in the mapper) but not rhythm, so durations are a draft the human corrects (ADR-0013,
  ADR-0019). Rests are not detected.
- **Chord band** (``bandTokens``) — populated in V13d (PaddleOCR is added to this engine there); empty
  here.

Coordinates are in the source image's own pixel grid (this engine does no resize), and
``source.imageWidth``/``imageHeight`` report that grid, so every coordinate is consistent with them.

Stable-API only (``threshold``, morphology, ``findContours``, projections) so it behaves the same on
the worker's pinned OpenCV < 5 and on a newer local OpenCV; it deliberately avoids ``HoughLinesP``,
whose return shape changed in OpenCV 5 (the reason the worker pins < 5 — a V9 finding).
"""

from __future__ import annotations

import time
from typing import Any

SCHEMA_VERSION = 2
ENGINE = "heuristic"
VERSION = "0.1.0"

# --- tunables, all in units of the estimated staff space where possible ---
# A horizontal run at least this fraction of the image width is a staff-line candidate.
_STAFF_LINE_WIDTH_FRAC = 0.5
# Two staff lines whose gap exceeds this multiple of the median line gap start a new staff.
_STAFF_SPLIT_GAP = 1.8
# A vertical run at least this fraction of a staff's full height is a barline. A stem reaches only
# from a notehead to about a third above the staff, so it stays under this even from an edge note.
_BARLINE_HEIGHT_FRAC = 0.85
# A notehead blob's size relative to the staff space (width, height ranges).
_HEAD_MIN_W, _HEAD_MAX_W = 0.6, 3.0
_HEAD_MIN_H, _HEAD_MAX_H = 0.6, 2.2
# A blob whose centre is within this many spaces of the staff (above/below) can be a note (ledgers).
_HEAD_STAFF_PAD_SPACES = 6.0


def version() -> str:
    return VERSION


def recognize(img_path: str, image_name: str | None = None) -> dict[str, Any]:
    """Run the heuristic pipeline and return an OmrDocument dict (schema owned by the model)."""
    import cv2
    import numpy as np

    start = time.perf_counter()
    image = cv2.imread(img_path, cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError("could not read the image as a raster")
    height, width = image.shape[:2]

    # Ink as 1, background 0. Otsu copes with a range of scan/photo exposures; inverse because ink is
    # dark on light paper.
    _, binary = cv2.threshold(image, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    ink = (binary > 0).astype(np.uint8)

    horizontal = _horizontal_runs(cv2, ink, width)
    staves = _detect_staves(np, horizontal, ink, width)

    vertical = _vertical_runs(cv2, ink, staves)
    barlines = _detect_barlines(np, vertical, staves)
    noteheads = _detect_noteheads(cv2, np, ink, horizontal, vertical, staves)

    elapsed = time.perf_counter() - start
    return {
        "schemaVersion": SCHEMA_VERSION,
        "source": {
            "engine": ENGINE,
            "engineVersion": VERSION,
            "imagePath": image_name or _basename(img_path),
            "imageWidth": int(width),
            "imageHeight": int(height),
            "provider": "cpu",
            "wallClockSeconds": round(elapsed, 3),
        },
        "staves": [_staff_dict(i, s) for i, s in enumerate(staves)],
        "zones": [],
        "noteheads": noteheads,
        "noteGroups": [],
        "barlines": barlines,
        "rests": [],
        "bandTokens": [],  # V13d adds PaddleOCR on the cropped band to this engine.
    }


# ---------------------------------------------------------------------------
# Morphology: isolate long horizontal and tall vertical ink runs
# ---------------------------------------------------------------------------


def _horizontal_runs(cv2: Any, ink: Any, width: int) -> Any:
    """A mask of the long horizontal ink — staff lines, mostly. Opened with a wide 1-px-tall kernel."""
    length = max(width // 30, 15)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (length, 1))
    return cv2.morphologyEx(ink * 255, cv2.MORPH_OPEN, kernel)


def _vertical_runs(cv2: Any, ink: Any, staves: list[dict[str, float]]) -> Any:
    """A mask of the tall vertical ink — barlines and stems. Kernel height ~ one staff's height."""
    span = _median_staff_span(staves)
    length = max(int(span * 0.6), 8)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, length))
    return cv2.morphologyEx(ink * 255, cv2.MORPH_OPEN, kernel)


# ---------------------------------------------------------------------------
# Staves
# ---------------------------------------------------------------------------


def _detect_staves(np: Any, horizontal: Any, ink: Any, width: int) -> list[dict[str, float]]:
    """Group extracted horizontal lines into staves of (about) five equally spaced lines."""
    row_ink = (horizontal > 0).sum(axis=1)
    threshold = _STAFF_LINE_WIDTH_FRAC * width
    line_rows = np.where(row_ink >= threshold)[0]
    lines = _cluster_runs(np, line_rows)
    if len(lines) < 2:
        return []

    gaps = np.diff(lines)
    median_gap = float(np.median(gaps))
    if median_gap <= 0:
        return []

    # Split the line list into staves wherever the gap jumps well above the typical inter-line gap.
    staves: list[dict[str, float]] = []
    run: list[float] = [float(lines[0])]
    for prev, cur in zip(lines, lines[1:]):
        if (cur - prev) > _STAFF_SPLIT_GAP * median_gap:
            staves.append(_staff_from_lines(np, run, ink, width))
            run = [float(cur)]
        else:
            run.append(float(cur))
    staves.append(_staff_from_lines(np, run, ink, width))

    # A staff has ~5 lines; keep runs of 3+ (noise can drop a line) and drop stray singletons/pairs.
    kept = [s for s in staves if s["_lines"] >= 3]
    kept.sort(key=lambda s: s["yUpper"])
    return kept


def _staff_from_lines(np: Any, run: list[float], ink: Any, width: int) -> dict[str, float]:
    y_upper = float(run[0])
    y_lower = float(run[-1])
    n = len(run)
    unit = (y_lower - y_upper) / (n - 1) if n >= 2 else 8.0
    x_left, x_right = _staff_x_extent(np, ink, y_upper, y_lower, width)
    return {
        "yUpper": y_upper,
        "yLower": y_lower,
        "yCenter": (y_upper + y_lower) / 2,
        "unit": unit if unit > 0 else 8.0,
        "xLeft": x_left,
        "xRight": x_right,
        "_lines": float(n),
    }


def _staff_x_extent(np: Any, ink: Any, y_upper: float, y_lower: float, width: int) -> tuple[float, float]:
    top = max(int(y_upper), 0)
    bottom = min(int(y_lower) + 1, ink.shape[0])
    band = ink[top:bottom, :]
    cols = np.where(band.sum(axis=0) > 0)[0]
    if cols.size == 0:
        return 0.0, float(width)
    return float(cols[0]), float(cols[-1])


# ---------------------------------------------------------------------------
# Barlines
# ---------------------------------------------------------------------------


def _detect_barlines(np: Any, vertical: Any, staves: list[dict[str, float]]) -> list[dict[str, Any]]:
    barlines: list[dict[str, Any]] = []
    for group, staff in enumerate(staves):
        top = max(int(staff["yUpper"]), 0)
        bottom = min(int(staff["yLower"]) + 1, vertical.shape[0])
        band = vertical[top:bottom, :]
        span = bottom - top
        if span <= 0:
            continue
        col_ink = (band > 0).sum(axis=0)
        tall = np.where(col_ink >= _BARLINE_HEIGHT_FRAC * span)[0]
        for x1, x2 in _column_runs(np, tall):
            barlines.append(
                {
                    "bbox": [int(x1), int(staff["yUpper"]), int(x2) + 1, int(staff["yLower"])],
                    "group": group,
                }
            )
    return barlines


# ---------------------------------------------------------------------------
# Noteheads
# ---------------------------------------------------------------------------


def _detect_noteheads(
    cv2: Any, np: Any, ink: Any, horizontal: Any, vertical: Any, staves: list[dict[str, float]]
) -> list[dict[str, Any]]:
    if not staves:
        return []
    # What's left once the staff lines and the vertical runs (stems, barlines) are removed is mostly
    # noteheads (and other symbols this engine does not model). uint8 subtraction saturates at 0.
    residue = cv2.subtract(cv2.subtract(ink * 255, horizontal), vertical)
    # A notehead sitting on a staff line was split in two by removing that line; close the thin
    # horizontal gap vertically so the head is one blob again (the classic staff-removal artefact).
    unit = _median_unit(staves)
    heal = max(int(unit * 0.5), 5)
    residue = cv2.morphologyEx(residue, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (1, heal)))
    residue = cv2.morphologyEx(residue, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))

    contours, _ = cv2.findContours(residue, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    noteheads: list[dict[str, Any]] = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        cx, cy = x + w / 2, y + h / 2
        group = _staff_for(staves, cx, cy)
        if group is None:
            continue
        unit = staves[group]["unit"]
        if not (_HEAD_MIN_W * unit <= w <= _HEAD_MAX_W * unit):
            continue
        if not (_HEAD_MIN_H * unit <= h <= _HEAD_MAX_H * unit):
            continue
        noteheads.append(
            {
                "id": len(noteheads),
                "bbox": [int(x), int(y), int(x + w), int(y + h)],
                "track": 0,
                "group": group,
                "noteGroupId": None,
                "staffLinePos": None,
                "pitch": None,
                "hasDot": False,
                "stemUp": None,
                "invalid": False,
                "label": "QUARTER",  # rhythm not read; a draft the human corrects (ADR-0019).
            }
        )
    noteheads.sort(key=lambda n: (n["group"], n["bbox"][0]))
    return noteheads


def _staff_for(staves: list[dict[str, float]], cx: float, cy: float) -> int | None:
    """The staff a blob at (cx, cy) belongs to: its centre within the staff's ledger range and x span."""
    best: int | None = None
    best_dy = None
    for group, staff in enumerate(staves):
        pad = staff["unit"] * _HEAD_STAFF_PAD_SPACES
        if cy < staff["yUpper"] - pad or cy > staff["yLower"] + pad:
            continue
        if cx < staff["xLeft"] - staff["unit"] or cx > staff["xRight"] + staff["unit"]:
            continue
        dy = abs(cy - staff["yCenter"])
        if best_dy is None or dy < best_dy:
            best, best_dy = group, dy
    return best


# ---------------------------------------------------------------------------
# Small numeric helpers
# ---------------------------------------------------------------------------


def _cluster_runs(np: Any, rows: Any) -> list[float]:
    """Collapse consecutive (or near-consecutive) row indices into one line at each run's mean y."""
    if rows.size == 0:
        return []
    lines: list[float] = []
    run = [int(rows[0])]
    for r in rows[1:]:
        if int(r) - run[-1] <= 2:
            run.append(int(r))
        else:
            lines.append(sum(run) / len(run))
            run = [int(r)]
    lines.append(sum(run) / len(run))
    return lines


def _column_runs(np: Any, cols: Any) -> list[tuple[int, int]]:
    """Collapse consecutive column indices into (start, end) runs — one barline drawn a few px wide."""
    if cols.size == 0:
        return []
    runs: list[tuple[int, int]] = []
    start = prev = int(cols[0])
    for c in cols[1:]:
        if int(c) - prev <= 3:
            prev = int(c)
        else:
            runs.append((start, prev))
            start = prev = int(c)
    runs.append((start, prev))
    return runs


def _median_unit(staves: list[dict[str, float]]) -> float:
    units = sorted(s["unit"] for s in staves)
    if not units:
        return 8.0
    mid = len(units) // 2
    return units[mid] if len(units) % 2 else (units[mid - 1] + units[mid]) / 2


def _median_staff_span(staves: list[dict[str, float]]) -> float:
    if not staves:
        return 40.0
    spans = sorted(s["yLower"] - s["yUpper"] for s in staves)
    mid = len(spans) // 2
    return spans[mid] if len(spans) % 2 else (spans[mid - 1] + spans[mid]) / 2


def _staff_dict(index: int, s: dict[str, float]) -> dict[str, Any]:
    return {
        "index": index,
        "track": 0,
        "group": index,
        "xLeft": float(s["xLeft"]),
        "xRight": float(s["xRight"]),
        "yUpper": float(s["yUpper"]),
        "yLower": float(s["yLower"]),
        "yCenter": float(s["yCenter"]),
        "unitSize": float(s["unit"]),
    }


def _basename(path: str) -> str:
    import os

    return os.path.basename(path)
