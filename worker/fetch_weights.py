"""Fetch oemer's ONNX segmentation weights into the installed package, verifying checksums.

oemer downloads its checkpoints on first CLI run (ADR-0024 calls this out as the thing
that breaks the offline requirement). The spike needs them present before it runs
in-process, and V10 will bake them into the image at build time. This script does the
fetch once and pins the two files by SHA-256, so a silently changed upstream artefact
fails here rather than producing different coordinates downstream.

Only the two ``.onnx`` files are fetched: the onnxruntime inference path (ADR-0025's CPU
floor) never touches the ``.h5`` Keras weights, which are only for ``--use-tf``.

Checksums recorded by the V9 spike (oemer 0.1.8 release asset "checkpoints"):

    1st_model.onnx -> unet_big/model.onnx  70767752 B  sha256 37512e85…cfba174
    2nd_model.onnx -> seg_net/model.onnx   38448467 B  sha256 ed2e1a86…56d9d82e

Usage:  python fetch_weights.py
"""

from __future__ import annotations

import hashlib
import os
import sys
import urllib.request

from oemer import MODULE_PATH

BASE = "https://github.com/BreezeWhite/oemer/releases/download/checkpoints"

# upstream asset name -> (destination dir under checkpoints/, expected size, sha256)
WEIGHTS = {
    "1st_model.onnx": ("unet_big", 70767752, "37512e858731096439746f60b377c049f07055b4a23ec6eb9a178ce92cfba174"),
    "2nd_model.onnx": ("seg_net", 38448467, "ed2e1a86ea75712ee6cdc740e96f7a36753543cf9bb980227c071c9256d9d82e"),
}


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    checkpoints = os.path.join(MODULE_PATH, "checkpoints")
    for asset, (subdir, size, digest) in WEIGHTS.items():
        dest = os.path.join(checkpoints, subdir, "model.onnx")
        if os.path.exists(dest) and sha256(dest) == digest:
            print(f"ok (cached): {subdir}/model.onnx")
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        print(f"downloading {asset} -> {subdir}/model.onnx ({size} B)")
        urllib.request.urlretrieve(f"{BASE}/{asset}", dest)
        got = sha256(dest)
        if got != digest:
            print(f"CHECKSUM MISMATCH for {asset}: expected {digest}, got {got}", file=sys.stderr)
            os.remove(dest)
            return 1
        print(f"verified: {subdir}/model.onnx")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
