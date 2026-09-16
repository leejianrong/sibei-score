"""Eyeball the V16b Stage-1 detector: run detect.onnx on a page and overlay the decoded boxes.

  SIBEI_DETECT_MODEL=out/v16b python worker/visualize_detect.py <image>... -o out/v16b-preds

Writes an overlay PNG per input. Uses onnxruntime CPU + the pure-numpy decode (no torch), the same
path the worker will use at inference (V16c). A box a few units off never fails a test but ruins the
draft, so we look (agent_docs/proofing.md).
"""

from __future__ import annotations

import argparse
import os
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
from training.detect_config import IN_H, IN_W  # noqa: E402
from training.detect_decode import decode  # noqa: E402

CLASSES = ["staff", "barline", "chordBand", "title"]
COLORS = {"staff": (47, 111, 224), "barline": (224, 83, 58), "chordBand": (18, 161, 80), "title": (161, 47, 208)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="+")
    ap.add_argument("-o", "--out", default="out/v16b-preds")
    ap.add_argument("--thresh", type=float, default=0.3)
    ap.add_argument("--model", default=os.environ.get("SIBEI_DETECT_MODEL", "out/v16b"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    sess = ort.InferenceSession(os.path.join(args.model, "detect.onnx"), providers=["CPUExecutionProvider"])
    name = sess.get_inputs()[0].name

    for path in args.images:
        img = Image.open(path).convert("L")
        w, h = img.width, img.height
        small = img.resize((IN_W, IN_H), Image.BILINEAR)
        arr = (np.asarray(small, dtype=np.float32) / 255.0 - 0.5) / 0.5
        x = arr[np.newaxis, np.newaxis, :, :]
        out = sess.run(None, {name: x})[0][0]  # [NC+4, GH, GW]
        dets = decode(out, orig_w=w, orig_h=h, thresh=args.thresh)

        counts: dict[str, int] = {}
        vis = img.convert("RGB")
        draw = ImageDraw.Draw(vis)
        for d in dets:
            cls = CLASSES[d["cls"]]
            counts[cls] = counts.get(cls, 0) + 1
            color = COLORS[cls]
            draw.rectangle([d["x"], d["y"], d["x"] + d["w"], d["y"] + d["h"]], outline=color, width=3)
            draw.text((d["x"] + 2, max(d["y"] - 12, 2)), f"{cls} {d['score']:.2f}", fill=color)
        dst = os.path.join(args.out, os.path.splitext(os.path.basename(path))[0] + ".detect.png")
        vis.save(dst)
        print(f"{os.path.basename(path)} ({w}x{h}) -> {dst}  {counts}")


if __name__ == "__main__":
    main()
