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


def warm_paddleocr() -> int:
    """Bake PaddleOCR's chord-band models into the image at build time (V13d, ADR-0027, ADR-0024).

    Unlike oemer's two pinned .onnx files, PaddleOCR manages its own model cache; the reliable way to
    bake it offline is to construct the pipeline once here, which downloads exactly the det + rec models
    our config uses (orientation/unwarping are off) into the cache the running container then reads with
    ``PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True``. Build time needs the network; runtime does not.

    Skipped (not failed) when PaddleOCR is absent, so an oemer-only build still works — the chord band
    is simply unavailable, which the engines already degrade to gracefully (band_ocr.default_band_ocr).
    """
    try:
        from sibei_omr.band_ocr import paddle_ocr
    except Exception as error:  # noqa: BLE001
        print(f"skip: PaddleOCR not installed ({type(error).__name__}); chord band will be unavailable")
        return 0
    print("warming the PaddleOCR model cache (det + rec)…")
    paddle_ocr()  # constructing it triggers the model download into the cache
    print("ok: PaddleOCR models cached")
    return 0


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
    return warm_paddleocr()


if __name__ == "__main__":
    raise SystemExit(main())
