# Bespoke recogniser training (V15b Stage-2a, V16b Stage-1, V17c Stage-2b)

Trains the bespoke models on the synthetic corpora and exports them to ONNX for CPU inference.
Dev/build-time only — the shipped worker loads the baked ONNX and never imports torch (ADR-0031,
ADR-0024). Three stages train here:

- **Stage 2a** — the melody recogniser (CRNN+CTC), `training.train` on the `pnpm dump:v15a` corpus.
- **Stage 1** — the layout detector, `training.detect_train` on the `pnpm dump:v16a` corpus (below).
- **Stage 2b** — the chord-band recogniser (CRNN+CTC), `training.chord_train` on the `pnpm dump:v17b`
  corpus (below).

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

## Stage 1 — the layout detector (V16b)

Finds staff systems, barlines, the chord band and the title block on a whole page, so `assemble.py`
(V16c) can crop each system for the Stage-2a recogniser instead of borrowing the heuristic engine's
OpenCV staff-finder (the real-photo bottleneck V15c hit). Bars and four-bar phrases are **derived**
from barline x + system breaks, never detected (ADR-0031).

```
pnpm dump:v16a  ->  corpus (pages + boxes + classes)  ->  training.detect_train  ->  detect.onnx
   (TypeScript)          out/v16a-corpus/                    (PyTorch, GPU)           (onnxruntime CPU)
```

1. **Generate the corpus** (from the repo root, Node side):

   ```sh
   pnpm dump:v16a --seeds 800 --bars 24 --out out/v16a-corpus --levels clean,light,medium,heavy
   ```

   The dump bakes *photometric* degradation only (perspective forced to 0, so boxes stay aligned);
   the geometric half (perspective/rotation) is on-the-fly, label-safe augmentation in the dataset,
   which warps image + boxes jointly. Gitignored, produced on demand.

2. **Train + export** (from `worker/`):

   ```sh
   python -m training.detect_train --corpus ../out/v16a-corpus --out ../out/v16b --epochs 40 --device cuda
   ```

   A tiny CPU smoke to prove the wiring end to end:

   ```sh
   pnpm dump:v16a --seeds 16 --bars 16 --out out/v16a-smoke --levels clean,light
   cd worker && python -m training.detect_train --corpus ../out/v16a-smoke --out ../out/v16b-smoke --epochs 3 --device cpu --workers 0
   ```

   Artifacts: `detect.onnx`, `detect.pt`, `metrics.json`. Validation reports per-class precision/
   recall/F1 at IoU 0.5; **staff recall is the headline** (ADR-0031: staff detection is the must-win),
   so the best checkpoint is selected on it.

### The detector

A small anchor-free centre-point detector (`detect_model.py`, CenterNet style): a plain conv stack
downsamples the page /16, and a head emits, per grid cell, a per-class centre heatmap plus a sub-cell
offset and a box size. It is the "YOLO-nano class" detector ADR-0031 asks for, built in the heatmap
style rather than with anchors — the ADR sanctions that as the fair alternative when box regression is
data-hungry, and it avoids the NMS + dynamic-output machinery that fought the V15b ONNX export. The
ONNX graph is the conv stack alone; **decoding the heatmap into boxes is host-side numpy**
(`detect_decode.py`), so the graph has no dynamic op and the worker reuses the same decode on
onnxruntime output at inference (V16c). Exported with the legacy TorchScript exporter (`dynamo=False`)
for the same clean static graph.

## Stage 2b — the chord-band recogniser (V17c)

Reads one system's chord-band strip into the raw chord text tokens that land in `bandTokens`, so the
V5 grammar corrector (ADR-0011) and V13's beat mapping ride on top **unchanged** — this stage only
replaces the OCR (PaddleOCR on oemer/heuristic today) with a small bespoke model at lower RAM. It does
not classify chords; it transcribes what is drawn, one glyph character at a time, exactly as the
character-level vocabulary is built (`packages/synth/src/chord-vocab.ts`).

```
pnpm dump:v17b  ->  corpus (band crops + char-id labels + vocab)  ->  training.chord_train  ->  chord.onnx
   (TypeScript)          out/v17b-corpus/                              (PyTorch, GPU)            (onnxruntime CPU)
```

1. **Generate the corpus** (from the repo root, Node side):

   ```sh
   pnpm dump:v17b --seeds 800 --bars 16 --out out/v17b-corpus --levels clean,light,medium
   ```

   Each chart is drawn in a per-seed random render style (V17a: music face, typeface, chord
   symbology) with rich chromatic chords (V17b-i); the label is the glyph string the chosen style
   actually draws, read back by `chordGlyphText`, so the CTC target and the pixels cannot drift.
   Gitignored, produced on demand.

2. **Train + export** (from `worker/`):

   ```sh
   python -m training.chord_train --corpus ../out/v17b-corpus --out ../out/v17c --epochs 30 --device cuda
   ```

   Validation holds out the last `--val-frac` of seeds. Two accuracies are reported — **character**
   accuracy (the direct CTC signal) and **chord** accuracy (each chord, the text between separators,
   scored atomically by Levenshtein). Chord accuracy is the headline — it is what the corrector
   consumes — so the best checkpoint is selected on it. Artifacts: `chord.onnx`, `chord.pt`,
   `metrics.json`.

   A tiny CPU smoke run to prove the wiring end to end:

   ```sh
   pnpm dump:v17b --seeds 40 --bars 12 --out out/v17b-smoke --levels clean
   cd worker && python -m training.chord_train --corpus ../out/v17b-smoke --out ../out/v17c-smoke --epochs 5 --device cpu --workers 0
   ```

3. **Export the matched vocab** (deterministic, for baking beside `chord.onnx`):

   ```sh
   pnpm export:v17c-vocab --out out/v17c/chord-vocab.json
   ```

### The band model

A small CRNN (`chord_model.py`), sized for the band's geometry rather than a system crop's. A band
crop is ~1386x30 px (aspect ~46:1) — very wide, very short — so it uses **five** height-pooling blocks
(/32, matched to a fixed 32px input) where Stage-2a uses six (/64); a sixth would drive the short input
below one row and break. Width is still pooled only twice (W // 4 time steps). CTC (blank = id 0)
aligns columns to the character sequence; the chord **separator** (id 1) splits the decode back into
distinct chords. Even leaner than Stage-2a — the v0.3 gate is accuracy **and** CPU RAM/speed
(ADR-0031). Augmentation drops rotation (label-safe on a square-ish staff crop, but a small angle
lifts a 46:1 strip's far end off-frame); photometric jitter and random erasing remain.

## RunPod (the real runs)

The `train-relay` transport is parameterized per stage, so the same relay trains any of the three
(generate the corpus locally, ship it + the training code, train on the GPU, pull back the ONNX):

```sh
# Stage 2b (V17c):
RP_DUMP_SCRIPT=dump:v17b RP_TRAIN_MODULE=training.chord_train \
  RP_TRAIN_ARTIFACT=chord.onnx RP_TRAIN_OUT=out/v17c \
  RP_DUMP_ARGS='--seeds 800 --bars 16 --levels clean,light,medium' \
  tools/runpod/rp train-relay --epochs 30
```

(Stage 2a is the default; set `RP_DUMP_SCRIPT=dump:v16a RP_TRAIN_MODULE=training.detect_train
RP_TRAIN_ARTIFACT=detect.onnx RP_TRAIN_OUT=out/v16b` for the Stage-1 detector.) CPU training is
unusably slow; the smoke runs above are only for proving the wiring. On-demand GPU only — spot pods
are discontinued (`agent_docs/v15-training-notes.md`) — and pin `numpy<2` (the relay already does).

## Dependencies

`requirements.txt` (torch, numpy, pillow, onnx) is training-only and is **not** in the runtime
worker image. The detector's `detect_decode.py` is pure numpy so the shipped worker can reuse it.
