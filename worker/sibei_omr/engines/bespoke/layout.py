"""Stage 1 of the bespoke engine: the trained layout detector (V16, ADR-0031).

Replaces the borrowed OpenCV staff-finder V15c leaned on — the real-photo bottleneck (a phantom
"staff" invented from the title, a missed low-contrast staff). A whole page in, the detector's
``detect.onnx`` (V16b) emits per-class centre heatmaps for staff/barline/chordBand/title; the numpy
decode (``detect_decode``) turns them into boxes, and this module assembles those boxes into the
**staves and barlines** the ``OmrDocument`` needs — the same geometry the heuristic engine produced,
so ``assemble.py`` and ``mapOmrToScore`` are unchanged.

Two facts from the V16b eval shape the assembly:

- **Barlines are the reliable signal** (synthetic F1 0.99, and strong on real photos), and a barline
  box spans exactly the staff (top line to bottom line), so barlines give the staff *height* even when
  the staff's own box height is imprecise. They are the backbone here.
- **Staff detections localise well but sit at a lower confidence on real ink** than on synthetic, so we
  decode them at a low score threshold and lean on barlines for geometry. A staff box gives the system
  its full-width x-extent (a barline does not reach the system edges).

So a *system* is a cluster of detections at one staff-centre y (staves + their barlines); its height
comes from the barlines (or the staff box as a fallback), its x-extent from the staff box (or the
barline span). Bars are **not** built here — they are derived downstream from the barline x-positions
+ system breaks (ADR-0031).
"""

from __future__ import annotations

import statistics
from typing import Any

from .detect_config import IN_H, IN_W
from .detect_decode import decode

# Class ids — the order `packages/synth` BOX_CLASSES / classes.json emits (V16a).
CLS_STAFF = 0
CLS_BARLINE = 1
CLS_CHORDBAND = 2
CLS_TITLE = 3

# Decode thresholds. Staff sits lower on real ink (V16b real-photo finding), so it is decoded more
# permissively than the crisp barlines; the width filter + clustering below remove the extra boxes.
_STAFF_SCORE = 0.20
_BARLINE_SCORE = 0.30
_DECODE_SCORE = min(_STAFF_SCORE, _BARLINE_SCORE)

# A real staff spans most of the printed width; a title/phantom box is narrower. Drop staff detections
# under this fraction of the page width so a boxed title never becomes a system.
_MIN_STAFF_WIDTH_FRAC = 0.35
# Two detections belong to the same system if their centres are within this fraction of a staff height.
_CLUSTER_FRAC = 0.75


def detect_layout(image: Any, np: Any, session: Any) -> "tuple[list[dict], list[dict]]":
    """Run the detector on a grayscale page and return ``(staves, barlines)`` in the source pixel grid.

    ``staves`` entries carry ``yUpper``/``yLower``/``yCenter``/``unit``/``xLeft``/``xRight`` (the shape
    ``stage2a`` and the mapper read); ``barlines`` carry ``bbox`` + ``group``.
    """
    height, width = image.shape[:2]

    resized = _resize(image, np, IN_W, IN_H)
    arr = (resized.astype(np.float32) / 255.0 - 0.5) / 0.5
    x = arr[np.newaxis, np.newaxis, :, :]
    logits = session.run(None, {session.get_inputs()[0].name: x})[0][0]  # [NC+4, GH, GW]
    dets = decode(logits, orig_w=width, orig_h=height, thresh=_DECODE_SCORE)

    staff_dets = [d for d in dets if d["cls"] == CLS_STAFF and d["score"] >= _STAFF_SCORE and d["w"] >= _MIN_STAFF_WIDTH_FRAC * width]
    barline_dets = [d for d in dets if d["cls"] == CLS_BARLINE and d["score"] >= _BARLINE_SCORE]

    staff_h_est = _staff_height_estimate(staff_dets, barline_dets, height)
    clusters = _cluster_by_y(staff_dets, barline_dets, _CLUSTER_FRAC * staff_h_est)

    staves: list[dict] = []
    barlines: list[dict] = []
    for group, cluster in enumerate(clusters):
        staff = _staff_from_cluster(cluster, width, staff_h_est)
        staves.append(staff)
        for b in cluster["barlines"]:
            # A barline box spans the staff; snap its top/bottom to the system's for a clean divider.
            barlines.append({"bbox": [int(b["x"]), int(staff["yUpper"]), int(b["x"] + b["w"]), int(staff["yLower"])], "group": group})

    return staves, barlines


def _resize(image: Any, np: Any, out_w: int, out_h: int) -> Any:
    """Resize a grayscale array to (out_h, out_w). cv2 if available, else a numpy nearest fallback."""
    try:
        import cv2

        return cv2.resize(image, (out_w, out_h), interpolation=cv2.INTER_AREA)
    except Exception:  # noqa: BLE001 — cv2 is present in the worker; the fallback keeps tests portable.
        ys = (np.linspace(0, image.shape[0] - 1, out_h)).astype(np.int64)
        xs = (np.linspace(0, image.shape[1] - 1, out_w)).astype(np.int64)
        return image[ys][:, xs]


def _staff_height_estimate(staff_dets: list[dict], barline_dets: list[dict], page_h: int) -> float:
    if barline_dets:
        return max(statistics.median([d["h"] for d in barline_dets]), 1.0)
    if staff_dets:
        return max(statistics.median([d["h"] for d in staff_dets]), 1.0)
    return max(page_h * 0.03, 1.0)  # ~a staff is a few percent of a page tall


def _cluster_by_y(staff_dets: list[dict], barline_dets: list[dict], gap: float) -> list[dict]:
    """Cluster staff + barline detections into systems by centre-y (one cluster per printed line)."""
    anchors = [{"cy": d["y"] + d["h"] / 2, "kind": "staff", "det": d} for d in staff_dets]
    anchors += [{"cy": d["y"] + d["h"] / 2, "kind": "barline", "det": d} for d in barline_dets]
    anchors.sort(key=lambda a: a["cy"])
    if not anchors:
        return []

    clusters: list[dict] = []
    current = {"cys": [anchors[0]["cy"]], "staves": [], "barlines": []}
    _add(current, anchors[0])
    for a in anchors[1:]:
        if a["cy"] - current["cys"][-1] > gap:
            clusters.append(current)
            current = {"cys": [], "staves": [], "barlines": []}
        current["cys"].append(a["cy"])
        _add(current, a)
    clusters.append(current)

    # Keep only clusters that are a real system: they have a staff box or at least one barline.
    return [c for c in clusters if c["staves"] or c["barlines"]]


def _add(cluster: dict, anchor: dict) -> None:
    (cluster["staves"] if anchor["kind"] == "staff" else cluster["barlines"]).append(anchor["det"])


def _staff_from_cluster(cluster: dict, page_w: int, staff_h_est: float) -> dict:
    barlines = cluster["barlines"]
    staffs = cluster["staves"]

    if barlines:
        height = max(statistics.median([b["h"] for b in barlines]), 1.0)
        y_center = statistics.median([b["y"] + b["h"] / 2 for b in barlines])
    elif staffs:
        height = max(statistics.median([s["h"] for s in staffs]), 1.0)
        y_center = statistics.median([s["y"] + s["h"] / 2 for s in staffs])
    else:  # unreachable: clusters without either are dropped in _cluster_by_y
        height, y_center = staff_h_est, staff_h_est

    unit = height / 4.0
    y_upper = y_center - height / 2.0
    y_lower = y_center + height / 2.0

    if staffs:  # a staff box gives the true full-width extent; a barline does not reach the edges.
        x_left = min(s["x"] for s in staffs)
        x_right = max(s["x"] + s["w"] for s in staffs)
    elif barlines:
        x_left = min(b["x"] for b in barlines) - unit
        x_right = max(b["x"] + b["w"] for b in barlines) + unit
    else:
        x_left, x_right = 0.0, float(page_w)

    x_left = max(0.0, x_left)
    x_right = min(float(page_w), x_right)
    return {
        "yUpper": float(y_upper),
        "yLower": float(y_lower),
        "yCenter": float(y_center),
        "unit": float(unit),
        "xLeft": float(x_left),
        "xRight": float(x_right),
    }
