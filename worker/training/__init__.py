"""Stage-2a recogniser training (V15b, ADR-0031).

Dev/build-time only: trains the bespoke CRNN on the synthetic V15a corpus and exports ONNX. NOT part
of the runtime worker image — the shipped worker loads the baked ONNX, it never imports torch. Kept
out of `sibei_omr` for that reason. See README.md.
"""
