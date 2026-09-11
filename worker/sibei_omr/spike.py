"""V9: the oemer coordinate spike (ADR-0023), now a thin CLI over the shared recogniser.

The spike proved oemer's note/barline pixel coordinates are reachable in-process, without a fork
(the gate for V10). Its recognition core — the in-process oemer stage sequence up to the
``oemer.layers`` registrations, stopping before the lossy MusicXML build — has moved into
``recognize.py`` (V10), which the worker's HTTP server also calls. This file is what remains of the
spike: a one-file CLI that runs the recogniser on an image and writes the JSON, plus the wall-clock
line ADR-0025 wanted documented.

The output conforms to the model-owned schema (``packages/model/src/omr.ts``, ``OmrDocument``); see
``recognize.py`` for the coordinate-space and dependency-pinning notes.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from sibei_omr.recognize import recognize


def run_oemer(img_path: str) -> dict:
    """Back-compat alias for the spike's original entry point; the core lives in ``recognize``."""
    return recognize(img_path)


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

    doc = recognize(args.image)

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
