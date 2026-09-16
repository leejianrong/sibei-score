# ADR-0031: A bespoke, staged recogniser as an alternative engine

- **Status:** Accepted — V15/V16 implemented; the default-engine swap is **earned for notes/bars,
  deferred to V17 for chords** (see "V16 result" below)
- **Date:** 2026-09-14
- **Deciders:** Jian, in design discussion
- **Relates to:** [ADR-0005](0005-node-owns-api-python-omr-worker.md),
  [ADR-0010](0010-hybrid-omr-pipeline-oemer.md),
  [ADR-0020](0020-omr-evaluation-strategy.md),
  [ADR-0023](0023-oemer-as-library-with-fork-contingency.md),
  [ADR-0024](0024-model-weights-baked-at-build-time.md),
  [ADR-0025](0025-cpu-only-floor-gpu-profile.md)

## Context

oemer ships as v0.2's engine (ADR-0010, ADR-0023) and works, but it is unsatisfactory on the
two axes the maintainer cares about:

- **Accuracy on real photographs.** V9 proved the coordinates are reachable, but on clean
  rendered charts; real-photo quality is the open question, and by eye it is not where a
  ship gate would want it.
- **Memory.** oemer recognises by dense per-pixel segmentation with two U-Nets over a
  ~3.67 MP page. V9 measured **~7 GB peak RSS**. ADR-0025's floor is on *speed* (CPU is the
  floor, GPU an opt-in that changes speed only); it says nothing about RAM, and 7 GB is a
  real deployment cost.

Three facts make an alternative worth pursuing rather than just tuning oemer:

- **The domain is unusually narrow.** Lead sheets are monophonic, single-staff, with a chord
  band above. The parts that make general OMR hard — polyphony, voice separation, multi-staff
  alignment — do not apply. Per-staff symbol recognition on a single voice is close to a
  solved problem in the literature (a small CRNN+CTC over a staff crop).
- **We own a ground-truth data generator.** `engrave` + `layout` + `model` + `music` render
  a `Score` to a pixel-exact page. Run in reverse it is a labeller: generate plausible lead
  sheets, render them, and read off both the detection boxes and the note/chord sequences for
  free. This is the thing that normally makes "train our own OMR" a multi-year labelling slog,
  and we have it already.
- **The engine boundary already exists and is clean (ADR-0005).** Everything downstream of
  recognition depends only on `OmrDocument` (`packages/model/src/omr.ts`), re-validated at the
  language boundary by `parseOmrDocument`. Swapping the engine is contained by construction.

## Decision

Pursue a **bespoke, staged recogniser as an *alternative* engine**, trained on synthetic data,
sized for CPU and low RAM — and let it **earn the default on the V12 evaluation harness**
(ADR-0020), never by eye. oemer is not removed; it becomes the incumbent that the challenger
must beat.

Four commitments hold this together.

1. **A staged pipeline, split by content.**
   - *Stage 1 — layout detection:* a small object detector (YOLO-nano class, CPU) finds staff
     systems, barlines, the chord band, and title/text blocks. Bars and four-bar phrases are
     **derived** from barlines + system breaks, not detected as objects — they are a layout
     convention, not a thing on the page.
   - *Stage 2a — the staff recogniser:* one system crop → an ordered note/rest sequence with
     x-positions (CRNN+CTC class). This is the probe slice (V15) because it is the most-solved
     sub-problem, so a failure there is a failure of the *data strategy*, not of an
     over-ambitious model.
   - *Stage 2b — the chord band:* a text problem, not a music one. A bespoke recogniser reads
     the band and feeds the **existing** V5 grammar corrector (ADR-0011) — reusing the
     mechanism, exactly as V13 does for PaddleOCR — and V13's stage-3 beat mapping rides on the
     coordinates unchanged.

2. **Conform to the contract.** A bespoke engine emits the **same `OmrDocument`**, coordinates
   and all, so `mapOmrToScore` (V11), the `WorkerClient` port, the job runner, the
   `/v1/imports` routes and both surfaces are **untouched**. Where the bespoke output genuinely
   cannot fit the schema, the schema is **evolved** (bump `OMR_SCHEMA_VERSION`), never bypassed.
   Coordinates stay a required field: they are the whole reason the raw layer exists (chord
   bounding boxes aligned to note/barline pixel X, ADR-0023 / Q71).

3. **Synthetic-first data, offline like everything else.** `packages/synth` reuses the render
   stack to emit `(image, labels)` pairs with domain randomisation (font, spacing, skew, blur,
   JPEG noise, paper texture, shadow), seeded and deterministic; a small real control set keeps
   it honest (ADR-0020). Training code and the corpus follow the `worker/fetch_weights.py`
   pattern — out of version control and out of every shipped image, produced/fetched on demand,
   with the trained weights **baked and checksummed at build time** (ADR-0024). Inference stays
   CPU-first (ADR-0025).

4. **Earn the swap.** An **engine-selection seam** in the worker
   (`sibei_omr/engines/{oemer,bespoke}/`) keeps both engines selectable by config, oemer the
   default. The default flips to `bespoke` **only** when it wins the harness on **accuracy *and*
   peak RAM**. V15 is the gate: fail it and the milestone stops and oemer stays.

One invariant exception is granted here, not assumed: **`packages/synth` is a deliberate
exception to the `model`/`layout`/`music` "no Node APIs" rule.** It is a build-time data tool,
not runtime, and must stay out of every product bundle — enforced by `tests/arch`, the way that
suite already guards the framework-free packages.

## V16 result — the swap is earned for notes/bars, and deferred for chords

The bespoke engine is now fully staged (V16): its own Stage-1 layout detector (`detect.onnx`, a small
CenterNet-style centre-point detector, ~1.8 MB) in place of the borrowed OpenCV staff-finder, plus the
V15c Stage-2a CRNN. Scored on the V12 harness (`docs/eval.md`), thread-pinned CPU:

- **Accuracy (notes).** noteF1 **~0.85 flat across clean/light/medium/heavy**, versus V15c's
  staff-finder-borrowing bespoke that collapsed to 0.20–0.38 on degraded pages — the robustness the
  milestone exists for. At or above oemer's ADR-0032 baseline on every level (0.851 vs 0.522 on
  `medium`). The detector holds **staff recall ~0.92** on held-out synthetic and localises staves
  page-wide on real photos where the borrowed finder invented a phantom title-staff.
- **Peak RAM.** ~**290 MB** (whole server, both models) vs oemer's ~7 GB — a ~24× reduction, the
  footprint escape this ADR exists to deliver.
- **Speed.** ~0.4 sec/page vs oemer's ~13 min/page.

**Decision: the default stays `oemer`.** By the swap rule below, the default flips only when bespoke
wins the **whole** harness on accuracy *and* peak RAM. Bespoke wins RAM, speed, notes and bars
decisively — but its `chordF1` is **0** (the bespoke chord band is V17) while oemer reads chords, so
bespoke does not yet win the *accuracy* axis in full. Flipping now would silently drop chord
recognition from every import. So V16 **earns** the notes/bars/RAM swap and **V17 completes it**, when
the bespoke chord band closes the last gap. (The like-for-like oemer note-baseline on the widened
corpus, KAN-1426, is taken at V17 — the V16 decision does not turn on it, since the chord gap blocks the
swap regardless and bespoke already leads on notes.)

## Alternatives considered

| Option | Why not |
|--------|---------|
| Keep oemer, tune it | No lever on RAM — the 7 GB is inherent to full-page dual-U-Net segmentation, not a tunable. Accuracy ceiling is someone else's unmaintained model (last release 2024-11, ADR-0023). |
| A full end-to-end transformer (image → sequence, TrOMR-like) | Heavier and far more data-hungry than a staged CRNN+CTC, and harder to keep the pixel coordinates that chord-to-beat alignment needs (ADR-0023 / Q71). The staged split lets each stage stay small and CPU-sized. |
| Switch to another off-the-shelf engine (Audiveris, homr) | MusicXML-only, no coordinates — the exact reason oemer beat them (ADR-0023, ADR-0027) — and no RAM guarantee either. |
| A cloud VLM or OCR API | Violates the offline invariant (ADR-0024, ADR-0025). Ruled out on principle, not performance. |
| A sequence-first contract (drop coordinates) | Larger blast radius, and it breaks the reason the raw `OmrDocument` layer exists. Deferred; revisit only if a bespoke model genuinely cannot carry coordinates, and then as its own ADR. |
| Train from scratch without the synthetic generator | The labelling slog the engraver lets us skip. It is the single fact that makes "train our own" tractable here. |

## Consequences

- **The riskiest unknown is confronted first.** Synthetic→real transfer is proven (or not) in
  V15, before the full pipeline is built on it. Failure returns us to oemer at low cost — the
  same gate-first discipline as ADR-0023 and ADR-0030.
- **This milestone depends on V12.** You cannot earn an engine swap without the harness that
  scores it (ADR-0020). It is the one cross-milestone dependency in the plan.
- **The engine boundary is what makes this safe and reversible.** Two engines coexist, are
  compared on the harness, and are swapped by config. The worker owns the coupling entirely
  (ADR-0005); nothing outside learns which engine ran.
- **RAM is now a first-class harness metric**, not just accuracy. It is half the reason the
  milestone exists, so V16's gate measures peak RAM alongside note accuracy.
- **Detection scope is unchanged from oemer for now.** Barline *type* is still not detected
  (ADR-0021), and clef/key/time/tie/triplet detection stays deferred (the V11 status note) — a
  schema + worker + real-fixture job that either engine shares, not something the bespoke
  pipeline resolves on its own.
- **A new maintenance surface is accepted**: models we train, a synthetic generator, and
  training code. This is a real cost, taken on deliberately, and it is affordable for exactly
  two reasons — the domain narrowness keeps the models small, and oemer stays the fallback
  until the bespoke engine has won the harness.
