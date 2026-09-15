# Stage-2a recogniser training (V15b)

Trains the bespoke melody recogniser on the synthetic V15a corpus and exports it to ONNX for
CPU inference. Dev/build-time only — the shipped worker loads the baked ONNX and never imports
torch (ADR-0031, ADR-0024).

## The pipeline

```
pnpm dump:v15a  ->  corpus (crops + labels + vocab)  ->  training.train  ->  model.onnx
   (TypeScript)          out/v15a-corpus/                  (PyTorch, GPU)      (onnxruntime CPU)
```

1. **Generate the corpus** (from the repo root, Node side):

   ```sh
   pnpm dump:v15a --seeds 800 --bars 16 --out out/v15a-corpus --levels clean,light,medium,heavy
   ```

   Baking the degradation levels here means training and the eval harness share one degradation
   distribution. The corpus is gitignored (it lives under `out/`), produced on demand.

2. **Train + export** (this package, run from `worker/`):

   ```sh
   python -m training.train --corpus ../out/v15a-corpus --out ../out/v15b --epochs 30 --device cuda
   ```

   Validation holds out the last `--val-frac` of seeds (unseen charts), so the token accuracy it
   prints measures generalization. Artifacts: `model.onnx`, `model.pt`, `metrics.json`.

   A tiny CPU smoke run to prove the wiring end to end:

   ```sh
   pnpm dump:v15a --seeds 12 --bars 8 --out out/v15a-smoke --levels clean
   cd worker && python -m training.train --corpus ../out/v15a-smoke --out ../out/v15b-smoke --epochs 5 --device cpu --workers 0
   ```

## On RunPod (the real run)

CPU training is unusably slow; the real run is a RunPod GPU pod (`worker/Dockerfile.gpu` +
`tools/runpod/rp`, ADR-0032). The corpus is generated locally (Node), shipped to the pod, trained on
the GPU, and the `model.onnx` shipped back — the same generate-locally / compute-on-pod shape as
`rp eval-relay`. Wiring the trained ONNX into `worker/sibei_omr/engines/bespoke` and scoring it on the
V12 harness is **V15c**, not here.

## The model

A small CRNN (`model.py`): a light conv stack pools the crop's height to one row of features while
keeping width as time steps (`W // 4`), a bidirectional GRU reads that sequence, and a linear layer
emits per-column logits over the vocabulary. CTC (blank = id 0) aligns the columns to the note/rest
token sequence, decoded greedily (`decode.py`). Deliberately small: the v0.3 gate is accuracy **and**
CPU RAM/speed (ADR-0031), and a single-staff lead sheet is a narrow problem.

## Dependencies

`requirements.txt` (torch, numpy, pillow, onnx) is training-only and is **not** in the runtime
worker image.
