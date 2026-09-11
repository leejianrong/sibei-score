"""The recogniser: one image in, an OmrDocument dict out (V10).

This is the V9 spike's in-process oemer stage sequence (``spike.py``), promoted into the reusable
core the worker's HTTP server calls. It runs oemer **as a library**, reaching its internal
``Staff`` / ``NoteHead`` / ``NoteGroup`` / ``Barline`` / ``Rest`` objects and their pixel
coordinates, and stops before oemer's lossy MusicXML build — coordinates are the whole reason oemer
was chosen (ADR-0010, ADR-0023), so the pipeline is copied up to the ``oemer.layers`` registrations
rather than run through oemer's CLI, which emits coordinate-free MusicXML.

Why in-process and not oemer's CLI: the CLI writes MusicXML, which has no coordinates at all, and
stage 3 of the import pipeline aligns chord bounding boxes to note/barline pixel X-coordinates
(Q71). Parsing the CLI's output would discard exactly the data the pipeline exists to consume.

The JSON shape is owned by the ``model`` package in TypeScript (``packages/model/src/omr.ts``,
``OmrDocument``), per ADR-0005: the worker conforms to a schema defined once, on the Node side, and
``parseOmrDocument`` re-validates it at the language boundary. Keep the two in sync.

Coordinate space: oemer normalises the input to ~3.67 megapixels (``inference.resize_image``) and
deskews it, so every coordinate is in that resized, dewarped space — NOT the original photo's pixel
grid. ``source.imageWidth``/``imageHeight`` report the bounds of that space, so the coordinates are
self-consistent with the bounds published. Stage 3 works entirely within this same space.

The runtime is pinned WITH the weights (V9 finding, extends ADR-0024): oemer==0.1.8,
onnxruntime==1.16.3 (newer refuses oemer's ConvTranspose nodes), opencv<5, numpy<2. See
``pyproject.toml`` and the Dockerfile.
"""

from __future__ import annotations

import os
import time
from typing import Any

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

SCHEMA_VERSION = 1
ENGINE = "oemer"


def _int(value: Any) -> Any:
    """numpy scalar / bool -> plain Python, so json.dump doesn't choke."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    try:
        return int(value)
    except (TypeError, ValueError):
        return value


def _bbox(bbox: Any) -> list[int] | None:
    if bbox is None:
        return None
    return [int(v) for v in bbox]


def _label_name(obj: Any) -> str | None:
    """oemer labels are enums (NoteType/RestType); dump their name, guarding None."""
    try:
        label = obj.label
    except Exception:
        return None
    if label is None:
        return None
    return getattr(label, "name", str(label))


def recognize(img_path: str, image_name: str | None = None) -> dict[str, Any]:
    """Run the oemer stages in-process and return an OmrDocument dict (schema in model).

    ``image_name`` overrides the provenance basename recorded in ``source.imagePath`` — the worker
    passes the client's original filename, since the on-disk path here is a temp file. Never a host
    path (ADR-0029): a basename only.
    """
    # Imported here, not at module top, so importing this module (and `--help`) stays cheap and free
    # of the multi-second tensorflow/onnxruntime import cost.
    import cv2
    import numpy as np
    from oemer import MODULE_PATH, layers
    from oemer.inference import inference
    from oemer.dewarp import estimate_coords, dewarp
    from oemer.staffline_extraction import extract as staff_extract
    from oemer.notehead_extraction import extract as note_extract
    from oemer.note_group_extraction import extract as group_extract
    from oemer.symbol_extraction import extract as symbol_extract
    from oemer.rhythm_extraction import extract as rhythm_extract

    # oemer.layers is a process-global; clear it so a second run in the same process is not
    # contaminated by the first (mirrors ete.clear_data). The worker serves one recognition at a
    # time (a lock in server.py), so this global is never contended.
    for name in layers.list_layers():
        layers.delete_layer(name)

    provider = "CPUExecutionProvider"
    start = time.perf_counter()

    # ---- Segmentation (the two U-Nets), onnxruntime CPU path (ADR-0025) ----
    staff_symbols_map, _ = inference(os.path.join(MODULE_PATH, "checkpoints/unet_big"), img_path)
    staff = np.where(staff_symbols_map == 1, 1, 0)
    symbols = np.where(staff_symbols_map == 2, 1, 0)

    sep, _ = inference(os.path.join(MODULE_PATH, "checkpoints/seg_net"), img_path)
    stems_rests = np.where(sep == 1, 1, 0)
    notehead = np.where(sep == 2, 1, 0)
    clefs_keys = np.where(sep == 3, 1, 0)

    image = cv2.imread(img_path)
    image = cv2.resize(image, (staff.shape[1], staff.shape[0]))

    # ---- Deskew (ete does this unless --without-deskew) ----
    coords_x, coords_y = estimate_coords(staff)
    staff = dewarp(staff, coords_x, coords_y)
    symbols = dewarp(symbols, coords_x, coords_y)
    stems_rests = dewarp(stems_rests, coords_x, coords_y)
    clefs_keys = dewarp(clefs_keys, coords_x, coords_y)
    notehead = dewarp(notehead, coords_x, coords_y)
    for i in range(image.shape[2]):
        image[..., i] = dewarp(image[..., i], coords_x, coords_y)

    symbols = symbols + clefs_keys + stems_rests
    symbols[symbols > 1] = 1
    layers.register_layer("stems_rests_pred", stems_rests)
    layers.register_layer("clefs_keys_pred", clefs_keys)
    layers.register_layer("notehead_pred", notehead)
    layers.register_layer("symbols_pred", symbols)
    layers.register_layer("staff_pred", staff)
    layers.register_layer("original_image", image)

    # ---- The stages whose objects carry the coordinates ----
    staffs, zones = staff_extract()
    layers.register_layer("staffs", staffs)
    layers.register_layer("zones", zones)

    notes = note_extract()
    layers.register_layer("notes", np.array(notes))
    layers.register_layer("note_id", np.zeros(symbols.shape, dtype=np.int64) - 1)
    _register_note_id(layers, np)

    groups, group_map = group_extract()
    layers.register_layer("note_groups", np.array(groups))
    layers.register_layer("group_map", group_map)

    barlines, clefs, sfns, rests = symbol_extract()
    layers.register_layer("barlines", np.array(barlines))
    layers.register_layer("clefs", np.array(clefs))
    layers.register_layer("sfns", np.array(sfns))
    layers.register_layer("rests", np.array(rests))

    # Assigns each note/symbol its track & group (which staff, which system).
    rhythm_extract()

    elapsed = time.perf_counter() - start

    height, width = image.shape[:2]
    doc: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "source": {
            "engine": ENGINE,
            "engineVersion": engine_version(),
            "imagePath": image_name or os.path.basename(img_path),
            "imageWidth": int(width),
            "imageHeight": int(height),
            "provider": provider,
            "wallClockSeconds": round(elapsed, 3),
        },
        # Staves carry their extent as x_left/x_right/y_upper/y_lower, always present.
        "staves": [_staff_dict(i, s) for i, s in enumerate(_flatten(staffs))],
        "zones": [[int(z.start), int(z.stop)] for z in zones],
        # Everything else is coordinate-first: an object with no bbox is detection noise with nothing
        # for stage 3 to align to, so it is dropped rather than dumped with a null coordinate (the
        # model schema requires bbox — see packages/model/src/omr.ts).
        "noteheads": [_note_dict(n) for n in _flatten(notes) if n.bbox is not None],
        "noteGroups": [_group_dict(g) for g in _flatten(groups) if g.bbox is not None],
        "barlines": [_barline_dict(b) for b in _flatten(barlines) if b.bbox is not None],
        "rests": [_rest_dict(r) for r in _flatten(rests) if r.bbox is not None],
    }
    return doc


def _register_note_id(layers: Any, np: Any) -> None:
    """Mirror ete.register_note_id: give each note its id (index into the notes array)."""
    symbols = layers.get_layer("symbols_pred")
    layer = layers.get_layer("note_id")
    notes = layers.get_layer("notes")
    for idx, note in enumerate(notes):
        if note.bbox is None:
            continue
        x1, y1, x2, y2 = note.bbox
        yi, xi = np.where(symbols[y1:y2, x1:x2] > 0)
        yi = yi + y1
        xi = xi + x1
        layer[yi, xi] = idx
        notes[idx].id = idx


def _flatten(objs: Any) -> list[Any]:
    """staff_extract returns a 2-D ndarray [group][track]; others return 1-D arrays/lists."""
    import numpy as np

    if isinstance(objs, np.ndarray):
        return [o for o in objs.flatten().tolist()]
    return list(objs)


def _staff_dict(index: int, s: Any) -> dict[str, Any]:
    unit = None
    try:
        unit = float(s.unit_size)
    except Exception:
        unit = None
    return {
        "index": index,
        "track": _int(s.track),
        "group": _int(s.group),
        "xLeft": float(s.x_left),
        "xRight": float(s.x_right),
        "yUpper": float(s.y_upper),
        "yLower": float(s.y_lower),
        "yCenter": float(s.y_center),
        "unitSize": unit,
    }


def _note_dict(n: Any) -> dict[str, Any]:
    return {
        "id": _int(n.id),
        "bbox": _bbox(n.bbox),
        "track": _int(n.track),
        "group": _int(n.group),
        "noteGroupId": _int(n.note_group_id),
        "staffLinePos": _int(n.staff_line_pos),
        "pitch": _int(n.pitch),
        "hasDot": bool(n.has_dot),
        "stemUp": None if n.stem_up is None else bool(n.stem_up),
        "invalid": bool(n.invalid),
        "label": _label_name(n),
    }


def _group_dict(g: Any) -> dict[str, Any]:
    return {
        "id": _int(g.id),
        "bbox": _bbox(g.bbox),
        "track": _int(g.track),
        "group": _int(g.group),
        "noteIds": [int(i) for i in (g.note_ids or [])],
        "stemUp": None if g.stem_up is None else bool(g.stem_up),
        "hasStem": None if g.has_stem is None else bool(g.has_stem),
    }


def _barline_dict(b: Any) -> dict[str, Any]:
    return {"bbox": _bbox(b.bbox), "group": _int(b.group)}


def _rest_dict(r: Any) -> dict[str, Any]:
    return {
        "bbox": _bbox(r.bbox),
        "track": _int(r.track),
        "group": _int(r.group),
        "hasDot": None if r.has_dot is None else bool(r.has_dot),
        "label": _label_name(r),
    }


def engine_version() -> str:
    try:
        from importlib.metadata import version

        return version("oemer")
    except Exception:
        return "unknown"
