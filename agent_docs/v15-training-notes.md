# V15 build notes: the bespoke Stage-2a training pipeline

A working log of the session that took the bespoke recogniser (ADR-0031) from "scaffolded" to a
GPU training run that produces an ONNX model. It records the decisions, and — more usefully — the
things that broke and how, so the next person doesn't rediscover them. Newest context first; the
plan of record is `SLICES.md` (V15) and the decisions are the ADRs.

## What got built

- **Phase 0 — a trustworthy oemer baseline.** Fixed KAN-1391 (below) and recorded the complete
  four-level oemer baseline in `docs/adr/0032`.
- **V15a — the synthetic training data** (`packages/synth`), in four merged slices: the flat-semantic
  CTC vocabulary (`vocab.ts`), per-system labels + crop cutter (`systems.ts`, `imaging/crops.ts`),
  the corpus dump (`scripts/v15a-dump-corpus.ts`, `pnpm dump:v15a`), and a wide symbol-variety
  expansion of the generator.
- **V15b — training** (`worker/training/`): a small CRNN+CTC, dataset/decode/train modules, TensorBoard/
  wandb tracking, on-the-fly augmentation, and `rp train-relay` — GPU training on a RunPod pod over the
  outbound-only relay, proven end-to-end (corpus → ship → train → ONNX → pull back → teardown).

## Decisions worth remembering

- **Flat-semantic CTC vocabulary** (one class per pitch×duration event) for the probe, over a factored
  or two-head scheme. It's the encoding the monophonic-OMR literature validated and its decode is one
  lookup, so a probe failure is a *data* failure, not a tokeniser one. The cost is a large, thin-tailed
  alphabet — 81 classes at first, **512** after the variety expansion. Watch per-class coverage; factor
  later if the tail bites. (Discussed in the CTC-vocabulary explainer; SLICES V15 note.)
- **Full-system crop** (staff + chord band + rehearsal letter), not a staff-only crop. High notes sit
  very close to the chord band, so a naive tight crop clips them, and the right tight-crop definition
  should match V15c's inference cropper, which doesn't exist yet. Settle it at V15c so train and
  inference crop identically.
- **The vocabulary is complete-by-construction** — derived from the same ladder + duration menu the
  generator draws from, so every token a corpus can emit has a class. A coverage test enforces it. This
  is why the variety expansion had to touch `generate.ts` and `vocab.ts` together.
- **On-the-fly augmentation is label-safe only.** OMR pitch is vertical position, so photometric jitter,
  a *small* rotation (staff + notes rotate together), and random erasing are fine; vertical shifts are
  not. Heavy degradation is baked into the corpus by the dump (`--levels`), matching the eval.
- **On-demand GPUs, not spot** (see below). **Small model on purpose** — the gate is accuracy *and* CPU
  RAM/speed, and the domain is narrow.

## What didn't work (the useful part)

### The oemer bug that started it all — KAN-1391

oemer threw `AttributeError: 'numpy.ndarray' object has no attribute 'start'` on some JPEG pages but
not others. Root cause: oemer's `init_zones` returns `np.array([range(a,b), …], dtype=object)`, and
**when every range has the same length numpy collapses the list into a 2-D int array**, so iterating
yields ndarray rows, not `range` objects, and `int(z.start)` blew up. It was input-specific because the
collapse only happens when the detected staff bounds divide evenly. Fix: `_zone_bounds` normalises a
zone whether it's a range/slice or an array-like row. Lesson: `np.array(list_of_sequences, dtype=object)`
is not shape-stable — equal-length inners silently become a rectangular array.

### RunPod, one failure at a time

The GPU training path took **five pod cycles** to get right. Each failure cost cents and none leaked a
pod (the verify-after-create guard and the trap teardown held every time), but they had to be found in
order:

1. **A mid-run 401.** During the oemer baseline run the API key started returning `401 Invalid API key`
   for ~15 minutes. It turned out the user had toggled the key; it wasn't rate-limiting. While it lasted
   I could neither read logs nor terminate via the API — the lesson being that **API-based teardown is
   not a backstop when auth is the thing that's broken**; the account spend cap and the pod's own
   dead-man's-switch are. Ended cleanly once the key came back (`pod list` empty).
2. **Spot pods are discontinued.** `interruptible: true` now returns
   `500 {"error":"create pod: Spot pods are no longer offered"}`. The eval path had used interruptible
   CPU pods happily days earlier, so this is recent. Fix: on-demand. (Also updated the `runpod-jobs`
   skill.)
3. **GPU availability and price.** The default GPU list (RTX A5000, RTX 3090) was unavailable, and the
   scheduler picked an RTX 4090 at $0.74/hr — over the $0.60 cap, so the guard terminated it. `runpodctl
   gpu list` shows the exact `gpuId` strings, cloud, on-demand price and stock; the working list is the
   available mid types (A6000 $0.53, A40 $0.49, L4, RTX 2000 Ada $0.24), dropping anything over cap.
4. **numpy 2 ABI break.** Training crashed at the first batch with `RuntimeError: Numpy is not available`
   — `pip install onnx tensorboard` had pulled numpy 2.x, whose ABI break makes `torch.from_numpy` fail
   against the image's torch 2.1. Fix: `pip install "numpy<2" …` on the pod.
5. **ONNX export of a dynamic op.** Training then ran to completion but exported no model:
   `AdaptiveAvgPool2d((1, None))` fails `torch.onnx.export` ("adaptive pooling, since output_size is not
   constant"). Fix: collapse the height with a plain mean (`ReduceMean`), which traces fine.

Diagnosing #2 needed the 500's response *body*, which `set -e` was swallowing before it printed — a
`--fail-with-body` curl captured behind `|| true` and a `RP_DEBUG_CREATE` flag surfaced it.

### Real validation images barely exist

A subagent went looking for freely-licensed real lead sheets (single staff + chord symbols) and found
the gap is structural, not effort: the chord-symbol lead-sheet format is a 20th-century convention, so
nearly every song in it is still under copyright, while public-domain music predates the convention and
was printed as grand-staff. The one genuine hit was handwritten and framed in a museum case —
out-of-distribution for a model trained on printed engraving. Conclusion: the real control set is the
maintainer photographing their own printed lead sheets (render-print-photograph gives exact ground
truth for free), not web-sourcing. The drop folder is `tests/fixtures/eval/real/samples/` (gitignored).

### Smaller things

- **8va/ottava is out of scope** — the engraver has no ottava at all, so octave lines can't be rendered
  or labelled. Requested, but can't be trained for.
- **The local box is an unreliable place to run the infra suite.** On the 8 GB WSL host, `pnpm check`'s
  infra layer times out spawning `sbscore serve` subprocesses (server-startup timeouts, plus orphaned
  serve processes from old sessions). It's environmental — CI on a clean host is green every time. Trust
  CI for the infra layer; the fast layer + typecheck are the deterministic local signal.
- **oemer is thread-bound, not core-bound** on a pod (onnxruntime over-subscribes ~128 host cores), so
  more vCPUs barely help — ~13 min/page regardless. A multi-seed oemer sweep is therefore expensive
  (filed as KAN-1426).

## What worked in the end

- **The relay transport generalised cleanly.** `rp train-relay` reuses the `eval-relay` pattern —
  generate locally, ship over a `runpodctl send`/`receive` relay (outbound-only, no public IP), run on
  the pod, ship the artifact back, dead-man's-switch throughout. A 120-chart / 20-epoch validation run
  went corpus → GPU → `model.onnx` end to end. Loss dropped 8.5 → 3.9; token accuracy was 0, which is
  the toy corpus, not the pipeline.
- **Cost safety held through five failed pod cycles.** Every failure terminated its pod (or never
  created one), and `runpodctl pod list` was empty after each. The layered guard (cap + verify + trap +
  pod-side switch) is worth the ceremony.
- **The complete-by-construction vocabulary caught its own drift.** Widening the generator would have
  silently produced unlabelable tokens; the coverage test failed loudly until `vocab.ts` enumerated the
  new durations and chromatic variants.

## Open items / next

- A **real training run** (bigger corpus, more epochs) for a meaningful number — the runs so far
  validated plumbing.
- **Per-class coverage** monitoring: 512 classes with a skewed distribution means rare pitch×duration
  combos are starved; check before blaming the model.
- **V15c — DONE (2026-09-16).** `worker/sibei_omr/engines/bespoke.py` loads the V15b ONNX on
  onnxruntime CPU, reuses the heuristic staff-finder for staves+barlines, crops each system to the
  full-system box (measured V15a proportions: above ≈1.6×, below ≈0.8× staff height — settled here so
  train and inference crop alike, the deferred decision), greedy-CTC-decodes, and derives each token's x
  from its **CTC column** (`crop_left + (t+0.5)·cropW/T`; the ÷4 downsample and the resize cancel). The
  flat-semantic token carries pitch+duration, so the notehead y is synthesised on the detected staff and
  round-trips through the mapper's `pitchFromGeometry` — the model gives the *sequence and x*, the
  geometry the *y*. Vocab is exported deterministically (`pnpm export:v15c-vocab`); model+vocab baked +
  checksummed (`bespoke_weights.py`). **Result:** clean-synthetic noteF1 **0.868 vs 0.120** heuristic, at
  ~0.3 sec/page and ~176 MB peak RAM (oemer ~7 GB / ~13 min) — the ADR-0031 footprint escape. The
  synthetic→real gap held up by eye on real photos (`worker/visualize_bespoke.py` → `out/v15c-real-preds/`):
  good note x-alignment on higher-res scans; the failure mode is the **borrowed staff-finder** (phantom
  title "staff", missed low-contrast staff) → V16, plus the **leading clef/key head** being OOD (the
  corpus renders none — a generator gap for v0.3). Two things learned worth carrying: (1) the mapper reads
  pitch from *geometry*, not a pitch field, so the engine only needs the sequence + a self-consistent y;
  (2) a `peakMB` schema field is a v2→v3 bump touching every engine/fixture, so it was deferred to the
  swap decision (V16) and peak RAM measured directly instead.
- **oemer baseline re-run**: the variety expansion made the eval corpus materially harder, so the
  `docs/adr/0032` baseline predates it (noted there). Still open (KAN-1426) — it is the accuracy-vs-oemer
  half of "earn the swap", which is V16's gate, not V15c's.

## V16 addendum: the Stage-1 layout detector (2026-09-16)

V16 trained the Stage-1 detector and completed the fully-staged bespoke engine. The transport
(`rp train-relay`, now parameterized for either stage via `RP_DUMP_SCRIPT`/`RP_TRAIN_MODULE`/
`RP_TRAIN_ARTIFACT`) reused V15b's relay unchanged — two GPU cycles, ~$0.30 total, every pod torn
down (`pod list` empty after each). What was learned this time, for V17's training:

- **Heatmap detector over anchor YOLO.** A CenterNet-style centre-point head (per-class heatmap +
  offset + size, `worker/training/detect_model.py`) was the right "YOLO-nano class" for this domain:
  the ONNX graph is a plain conv stack (no NMS, no dynamic op — the V15b AdaptiveAvgPool trap does not
  recur), and decoding is host-side numpy (`detect_decode.py`), reused verbatim by the worker.
- **Grid stride is the staff-detection lever.** At `/16`, a staff and the chord band above it are only
  ~2 grid rows apart and the detector confused them — staff recall plateaued at 0.66 even at IoU 0.3.
  Dropping to `/8` (pool 3 of 4 blocks) doubled the vertical grid and lifted **staff recall 0.66 →
  0.92**. If a short, vertically-adjacent class is being missed, look at the grid before the model.
- **IoU-0.5 is brutal for short-but-wide boxes.** A staff/band box is ~40/16 units tall and full-width,
  so a small vertical-centre error tanks IoU even when the object is correctly located. Read staff/band
  quality at IoU 0.3 (localisation) as well as 0.5 (box precision); the centres were good long before
  the boxes were tight.
- **Barlines are the reliable backbone; derive geometry from them.** Barline F1 was 0.99 and robust on
  real photos, and a barline box spans exactly the staff — so `layout.py` takes each system's *height*
  from its barlines, not the imprecise staff-box height. Build the robust signal into assembly rather
  than chasing the weak one in the model.
- **Checkpoint selection on a noisy val metric grabs a spike.** Staff recall swung 0.08–0.93 epoch to
  epoch (score-threshold sensitivity, no LR decay). Selecting best-on-staff-recall picked epoch 7's
  spike; it *held* on fresh unseen seeds (0.92), but for V17 prefer a smoother selection (micro-F1) +
  cosine LR decay for a less lucky pick.
- **The synth→real gap is a confidence shift, not a localisation failure.** On real photos staves
  score lower than on synthetic but land in the right place; the engine decodes staff at a low score
  threshold (~0.20 vs barline ~0.30) and leans on barlines. Validate on the real samples with
  `worker/visualize_detect.py` before trusting a threshold.
- **The swap is chord-blocked, not accuracy-blocked.** bespoke-full beat oemer on notes/bars/RAM/speed
  decisively, but chordF1 is 0 until V17, so the default stays oemer (a swap would drop chords). The
  oemer widened-corpus note-baseline (KAN-1426) was deferred to V17's real swap — it doesn't change the
  V16 decision. Take it on a pod at V17 (`rp eval-relay`), oemer OOMs on the 8 GB host.

## V17c addendum: the Stage-2b chord-band recogniser (2026-09-17)

V17c trained the last recogniser stage — the bespoke chord-band OCR that unblocks the swap. One GPU
cycle (A40, $0.49/hr, ~10 min incl. corpus ship + train + pull-back), pod torn down (`pod list` empty
after). The `train-relay` transport carried it unchanged via `RP_DUMP_SCRIPT=dump:v17b
RP_TRAIN_MODULE=training.chord_train RP_TRAIN_ARTIFACT=chord.onnx RP_TRAIN_OUT=out/v17c`. **Result: best
held-out chord accuracy 0.968** (character accuracy 0.987, whole-band exact 0.909) on unseen charts,
converging by epoch ~10 and holding flat — and by eye on fresh seeds (900+) it reads dense chromatic
bands right, the few misses being one-character slips (`A♭dim7`→`A♭di7`) the V5 corrector repairs, so
0.968 is a *raw-OCR floor*. What was worth carrying:

- **Band geometry, not the note recipe, drove the model.** A band crop is ~1386×30 px (aspect ~46:1),
  nothing like a 128px-tall system crop. Stage-2a's six height-pool blocks (/64) drive a ~32px input
  below one row and break, so `ChordCRNN` uses **five** (/32) at a 32px fixed height that barely resizes
  the native strip. If you reuse a CRNN across stages, re-derive the pooling from the *input* height
  first.
- **Rotation is label-safe on a square crop but destructive on a strip.** A 1.5° rotation lifts a 46:1
  band's far end ~36px — off the top of the 30px strip. Dropped it from the band augmentation (kept
  photometric jitter + random erasing); Stage-2a keeps rotation because a system crop is square-ish.
- **The character vocab paid off exactly as designed.** Open-vocabulary chords (`Bb13#11`, `F#m7b5`,
  `Ab/Eb`) read one glyph at a time (40 classes: blank, a `<sep>`, ~38 glyphs), so the model transcribes
  what is drawn and the V5 corrector + V13 beat mapping ride on top unchanged — 40 classes is a far
  gentler tail than Stage-2a's 512 flat-semantic note classes, which is why chord accuracy climbed fast.
- **The V15b ONNX-export trap recurs on new local torch, not just the pod.** Torch 2.14 (the CPU smoke
  box) defaults to the dynamo exporter and needs `onnxscript`; the fix is the V16 `dynamo=False` in a
  try/except `TypeError` (torch 2.1 on the pod has no such kwarg). Bake this into every stage's exporter,
  not just the detector's.
- **Local onnx/ml_dtypes skew on Python 3.13.** The CPU smoke venv pulled an `onnx` newer than its
  `ml_dtypes` (`AttributeError: module 'ml_dtypes' has no attribute 'float4_e2m1fn'`); `pip install -U
  ml_dtypes` fixed it. Purely a smoke-box issue — the pod's Python 3.10 + pinned `numpy<2` is unaffected.
- **Cosine LR decay gave a smooth pick.** Per the V16 note, added `CosineAnnealingLR`; chord accuracy
  settled at ~0.967 across the last ten epochs rather than spiking, so best-on-chord-accuracy selection
  grabbed a representative checkpoint, not a lucky one.

Wiring Stage 2b into `engines/bespoke/chords.py` + `assemble.py`'s `bandTokens` is **V17d**; scoring the
whole bespoke import (notes + chords) on the harness is **V17e**; the oemer widened baseline (KAN-1426)
+ the default swap is **V17f**.
