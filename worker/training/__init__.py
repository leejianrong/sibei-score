"""Bespoke recogniser training (V15b Stage-2a, V16b Stage-1; ADR-0031).

Dev/build-time only: trains the bespoke models on the synthetic corpora (`pnpm dump:v15a` for the
Stage-2a CRNN, `pnpm dump:v16a` for the Stage-1 detector) and exports ONNX. NOT part of the runtime
worker image — the shipped worker loads the baked ONNX, it never imports torch. Kept out of `sibei_omr`
for that reason, except the detector's *decode* (`detect_decode.py`, pure numpy) which the worker
reuses on onnxruntime output at inference. See README.md.
"""
