"""V9: the oemer coordinate spike (ADR-0023).

Runs oemer **in-process, as a library** on one raster image of a printed lead sheet,
reaches its internal ``Staff`` / ``NoteHead`` / ``NoteGroup`` / ``Barline`` / ``Rest``
objects, and dumps every one with its pixel coordinates and attributes to JSON. It also
measures CPU wall-clock, which ADR-0025 needs documented.

Why in-process and not the CLI: oemer's command-line entry point emits MusicXML, which
has **no coordinates at all** — and stage 3 of the pipeline (ADR-0010) aligns chord
bounding boxes to note/barline pixel X-coordinates. Parsing the CLI's MusicXML would
discard exactly the data the whole import pipeline exists to consume (Q71, ADR-0023).

How the coordinates are reached: oemer's own end-to-end routine (``oemer/ete.py``:
``extract``) runs the stages and stashes their results in a process-global registry,
``oemer.layers``. The objects we need are registered there as ``staffs``, ``notes``,
``note_groups``, ``barlines`` and ``rests``. This file replicates ``extract`` up to and
including those registrations, then reads them back — it stops before the MusicXML build,
which is the lossy step we are avoiding. The pipeline is copied rather than imported
because ``extract`` is welded to writing a ``.musicxml`` file; nothing in oemer exposes
"run the stages and hand me the objects".

The JSON shape is owned by the ``model`` package in TypeScript
(``packages/model/src/omr.ts``, ``OmrDocument``), per ADR-0005: the worker conforms to a
schema defined once, on the Node side. Keep the two in sync.

Coordinate space: oemer normalises the input to ~3.67 megapixels (``inference.resize_image``)
and then deskews it, so every coordinate below is in that resized, dewarped space — NOT
the original photo's pixel grid. ``source.imageWidth``/``imageHeight`` report the bounds
of that space (the shape of the ``original_image`` layer), so the coordinates are
self-consistent with the bounds we publish. Stage 3 works entirely within this same
space, so the normalisation is not a problem to solve here; it is a fact to record.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
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


def run_oemer(img_path: str) -> dict[str, Any]:
    """Run the oemer stages in-process and return an OmrDocument dict (schema in model)."""
    # Imported here, not at module top, so `--help` and import of this module stay cheap
    # and free of the multi-second tensorflow/onnxruntime import cost.
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

    # oemer.layers is a process-global; clear it so a second run in the same process is
    # not contaminated by the first (mirrors ete.clear_data).
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
            "engineVersion": _engine_version(),
            "imagePath": os.path.basename(img_path),
            "imageWidth": int(width),
            "imageHeight": int(height),
            "provider": provider,
            "wallClockSeconds": round(elapsed, 3),
        },
        # Staves carry their extent as x_left/x_right/y_upper/y_lower, always present.
        "staves": [_staff_dict(i, s) for i, s in enumerate(_flatten(staffs))],
        "zones": [[int(z.start), int(z.stop)] for z in zones],
        # Everything else is coordinate-first: an object with no bbox is detection noise
        # with nothing for stage 3 to align to, so it is dropped rather than dumped with a
        # null coordinate (the model schema requires bbox — see packages/model/src/omr.ts).
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


def _engine_version() -> str:
    try:
        from importlib.metadata import version

        return version("oemer")
    except Exception:
        return "unknown"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="sibei-omr-spike",
        description="V9 oemer coordinate spike: dump detected objects + pixel coordinates to JSON.",
    )
    parser.add_argument("image", help="Path to a raster image of a printed lead sheet.")
    parser.add_argument("-o", "--output", help="Path to write the JSON dump.", default=None)
    args = parser.parse_args(argv)

    if not os.path.exists(args.image):
        print(f"no such image: {args.image}", file=sys.stderr)
        return 2

    doc = run_oemer(args.image)

    out_path = args.output or (os.path.splitext(args.image)[0] + ".omr.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2)
        fh.write("\n")

    src = doc["source"]
    print(
        f"\n{src['imagePath']}: {len(doc['staves'])} staves, "
        f"{len(doc['noteheads'])} noteheads, {len(doc['noteGroups'])} groups, "
        f"{len(doc['barlines'])} barlines, {len(doc['rests'])} rests",
    )
    print(f"coordinate space: {src['imageWidth']}x{src['imageHeight']} ({src['provider']})")
    print(f"CPU wall-clock: {src['wallClockSeconds']:.1f}s")
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
