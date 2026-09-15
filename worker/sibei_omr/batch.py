"""Batch recognition: a directory of images in, one OmrDocument JSON per image out (KAN-1379).

This is the on-pod eval path (ADR-0032). oemer's recognition is ~5.4 min/page and, as the ADR-0032
gate found, cannot survive a single multi-minute HTTP request over the internet (a Cloudflare proxy
cap, inconsistent TCP holds, and the ``WorkerClient``'s inherited undici timeout all abort it). The
fix is **co-location**: run recognition on the pod with no per-image WAN. This module is that runner.

It imports the chosen engine **once** (the tensorflow/onnxruntime import and oemer's ~7 GB model load
are the expensive part), then loops the images, so a 12-image corpus pays the import cost once rather
than twelve times over (which is what looping ``spike.py`` would do). It is otherwise the same core
the HTTP server calls (``recognize.py`` via the engine seam), so the OmrDocument it writes is
byte-for-byte what a real ``/recognize`` would have returned — the laptop then maps and scores it
through the existing ``@sibei/synth`` metrics (``scripts/eval.ts --engine dump``), so the number is
identical to a worker run, just delivered without the network in the middle.

It stays RunPod-agnostic (ADR-0005: the worker never learns where it runs). ``tools/runpod/rp`` owns
the pod lifecycle and drives this over ssh; this file just reads a dir and writes a dir. Standalone,
outside the pnpm workspace, its own ``unittest`` — not in the Node CI.

Usage:

    python -m sibei_omr.batch <in_dir> <out_dir> [--engine oemer|heuristic]

Output naming: ``<stem>.omr.json`` per input image, so ``seed-0_bars-8_clean.png`` (the name
``eval.ts --dump-corpus`` writes) becomes ``seed-0_bars-8_clean.omr.json`` (the name
``eval.ts --engine dump`` reads). The stem is preserved regardless of image extension.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any, Callable, NamedTuple

from sibei_omr.engines import DEFAULT_ENGINE, ENGINE_NAMES, get_engine

RecognizeFn = Callable[[str, "str | None"], dict[str, Any]]

IMAGE_EXTS = (".png", ".jpg", ".jpeg")


class BatchResult(NamedTuple):
    """What the batch did, so the caller (``main``, a test) can report and set an exit code."""

    ok: list[str]
    failed: list[tuple[str, str]]  # (image name, short error message)


def list_images(in_dir: str) -> list[str]:
    """Image basenames in ``in_dir``, sorted for a stable, reproducible order."""
    return sorted(
        name
        for name in os.listdir(in_dir)
        if os.path.splitext(name)[1].lower() in IMAGE_EXTS
    )


def run_batch(in_dir: str, out_dir: str, recognize_fn: RecognizeFn) -> BatchResult:
    """Recognise every image in ``in_dir``, writing ``<stem>.omr.json`` into ``out_dir``.

    ``recognize_fn`` is injected — the same seam ``server.serve`` uses — so a test drives this with a
    fake that returns a canned document, no oemer or weights. ``main`` resolves it from the engine.

    A per-image failure is caught, reported, and skipped rather than aborting the batch: on a slow pod
    one bad page should not throw away the recognitions that already succeeded (they cost minutes
    each). The caller decides what a partial batch means; ``main`` exits non-zero if anything failed.
    """
    os.makedirs(out_dir, exist_ok=True)
    ok: list[str] = []
    failed: list[tuple[str, str]] = []
    images = list_images(in_dir)
    total = len(images)

    for index, name in enumerate(images, start=1):
        img_path = os.path.join(in_dir, name)
        stem = os.path.splitext(name)[0]
        out_path = os.path.join(out_dir, f"{stem}.omr.json")
        # This line carries the token "recognize" on purpose: when `rp` tees this output to the pod's
        # worker log, the ADR-0032 idle watchdog counts it as activity and keeps the pod alive through
        # the batch (the watchdog greps that log for "recognize"). Progress goes to stderr so stdout
        # stays clean if a caller ever wants to parse it.
        start = time.perf_counter()
        print(f"recognize [{index}/{total}] {name} ...", file=sys.stderr, flush=True)
        try:
            doc = recognize_fn(img_path, name)
            with open(out_path, "w", encoding="utf-8") as fh:
                json.dump(doc, fh)
                fh.write("\n")
            elapsed = time.perf_counter() - start
            print(f"recognize [{index}/{total}] {name} -> {stem}.omr.json ({elapsed:.1f}s)",
                  file=sys.stderr, flush=True)
            ok.append(name)
        except Exception as error:  # noqa: BLE001 — one page's failure must not abort the batch.
            message = f"{type(error).__name__}: {error}"
            print(f"recognize [{index}/{total}] {name} FAILED: {message}", file=sys.stderr, flush=True)
            failed.append((name, message))

    return BatchResult(ok=ok, failed=failed)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="sibei-omr-batch",
        description="Recognise a directory of images to one OmrDocument JSON each (ADR-0032 on-pod eval).",
    )
    parser.add_argument("in_dir", help="Directory of input images (.png/.jpg/.jpeg).")
    parser.add_argument("out_dir", help="Directory to write <stem>.omr.json into (created if absent).")
    parser.add_argument(
        "--engine",
        default=os.environ.get("SIBEI_OMR_ENGINE", DEFAULT_ENGINE),
        choices=ENGINE_NAMES,
        help="which recognition engine to run (default oemer; heuristic is low-RAM dev scaffolding).",
    )
    args = parser.parse_args(argv)

    if not os.path.isdir(args.in_dir):
        print(f"no such directory: {args.in_dir}", file=sys.stderr)
        return 2

    engine = get_engine(args.engine)
    print(f"sibei-omr batch: engine={engine.name} ({engine.version()})", file=sys.stderr, flush=True)

    result = run_batch(args.in_dir, args.out_dir, engine.recognize)

    print(
        f"batch done: {len(result.ok)} ok, {len(result.failed)} failed "
        f"(out={args.out_dir})",
        file=sys.stderr,
        flush=True,
    )
    for name, message in result.failed:
        print(f"  failed: {name}: {message}", file=sys.stderr)
    return 0 if not result.failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
