"""Draw the bespoke engine's predictions onto an image, for eyeballing what the model read (V15c).

Recognition accuracy on synthetic charts is the V12 harness's number; this is the qualitative
companion for **real photos**, where there is no ground truth to score against — you look at the
overlay and judge whether the model is reading the page. It runs the bespoke engine and draws, on a
copy of the source image:

  * each detected staff as a faint box, with its group index;
  * each barline as a vertical line;
  * each recognised notehead as a dot at its bbox centre, labelled with the **pitch import will read**
    (treble geometry, `mapOmrToScore.pitchFromGeometry`) and the duration the model predicted;
  * each rest as a small square, labelled with its duration.

Two caveats the overlay makes visible on purpose. The pitch label is the *geometric* pitch the mapper
derives (natural — the default key is C major and accidental symbols are not in the schema), so a note
the model read as F#5 shows as "F5"; that is exactly the flattening the import does, not a visualiser
bug. And the model has no vocabulary for triplets/tuplets (the generator emits none, `vocab.ts`), so a
tuplet figure on a real chart is read as its nearest plain durations.

    SIBEI_BESPOKE_MODEL_DIR=../out/v15b python visualize_bespoke.py IMAGE... --out ../out/v15c-real-preds

Each input writes ``<name>.pred.png`` (the overlay) and ``<name>.omr.json`` (the raw OmrDocument) into
``--out``. Copyrighted source photos and their derivatives stay out of git (``out/`` is gitignored).
"""

from __future__ import annotations

import argparse
import json
import os
import sys

_LETTERS = ["C", "D", "E", "F", "G", "A", "B"]
_LABEL_SHORT = {"WHOLE": "1", "HALF": "2", "QUARTER": "4", "EIGHTH": "8", "SIXTEENTH": "16", "THIRTY_SECOND": "32"}


def _geometric_pitch(cy: float, staff: dict) -> str:
    """The pitch `mapOmrToScore` will read for a head at centre y on this staff (treble, natural)."""
    unit = staff["unitSize"] or 8.0
    steps = round((staff["yLower"] - cy) / (unit / 2.0))
    diatonic = (4 * 7 + _LETTERS.index("E")) + steps  # E4 is the bottom line
    step = _LETTERS[diatonic % 7]
    octave = diatonic // 7
    return f"{step}{octave}"


def visualize(image_path: str, out_dir: str) -> dict:
    import cv2

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from sibei_omr.engines.bespoke import recognize

    name = os.path.splitext(os.path.basename(image_path))[0]
    doc = recognize(image_path, os.path.basename(image_path))

    canvas = cv2.imread(image_path, cv2.IMREAD_COLOR)
    staves = {s["index"]: s for s in doc["staves"]}

    for s in doc["staves"]:
        cv2.rectangle(canvas, (int(s["xLeft"]), int(s["yUpper"])), (int(s["xRight"]), int(s["yLower"])), (200, 200, 200), 1)

    for b in doc["barlines"]:
        x1, y1, _x2, y2 = b["bbox"]
        cv2.line(canvas, (int(x1), int(y1)), (int(x1), int(y2)), (255, 150, 0), 1)

    for n in doc["noteheads"]:
        x1, y1, x2, y2 = n["bbox"]
        cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
        cv2.circle(canvas, (cx, cy), 4, (0, 0, 220), -1)
        staff = staves.get(n["group"])
        pitch = _geometric_pitch(cy, staff) if staff else "?"
        dot = "." if n["hasDot"] else ""
        cv2.putText(canvas, f"{pitch}{_LABEL_SHORT.get(n['label'], '?')}{dot}", (cx - 6, cy - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.32, (0, 0, 220), 1, cv2.LINE_AA)

    for r in doc["rests"]:
        x1, y1, x2, y2 = r["bbox"]
        cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
        cv2.rectangle(canvas, (cx - 4, cy - 4), (cx + 4, cy + 4), (0, 150, 0), -1)
        dot = "." if r["hasDot"] else ""
        cv2.putText(canvas, f"R{_LABEL_SHORT.get(r['label'], '?')}{dot}", (cx - 6, cy - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.32, (0, 150, 0), 1, cv2.LINE_AA)

    os.makedirs(out_dir, exist_ok=True)
    cv2.imwrite(os.path.join(out_dir, f"{name}.pred.png"), canvas)
    with open(os.path.join(out_dir, f"{name}.omr.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2)

    summary = {
        "image": os.path.basename(image_path),
        "staves": len(doc["staves"]),
        "noteheads": len(doc["noteheads"]),
        "rests": len(doc["rests"]),
        "barlines": len(doc["barlines"]),
        "wallClockSeconds": doc["source"]["wallClockSeconds"],
    }
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="visualize_bespoke", description=__doc__)
    parser.add_argument("images", nargs="+", help="image files (or globs your shell expands)")
    parser.add_argument("--out", default="out/v15c-real-preds", help="output directory for overlays + JSON")
    args = parser.parse_args(argv)

    for image in args.images:
        try:
            summary = visualize(image, args.out)
            print(json.dumps(summary))
        except Exception as error:  # noqa: BLE001 — one bad image should not stop the batch.
            print(json.dumps({"image": os.path.basename(image), "error": f"{type(error).__name__}: {error}"}))
    print(f"wrote overlays + JSON to {args.out}/", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
