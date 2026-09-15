# Evaluating the OMR pipeline

How good is import? Not "looks about right" — a number, tracked over time, so a change to the
recogniser is measured rather than admired (ADR-0020). This is what V12 delivers and what v0.3's
engine swap is decided on: the bespoke recogniser earns the default **only** by beating oemer on this
harness, never by eye (ADR-0031).

## Running it

```sh
make eval                      # oemer worker on 127.0.0.1:8000; 6 charts x 4 degradations + real set
make eval ARGS="--engine fixture"   # no oemer: a plumbing smoke over the committed OMR dump
make eval ARGS="--seeds 12 --bars 16"
pnpm eval --json               # machine-readable
```

The harness generates a synthetic corpus (`@sibei/synth`: seeded plausible lead sheets), degrades
each chart into a photograph (`@sibei/synth/imaging`: perspective, blur, shadow, paper texture,
noise, JPEG), runs a recogniser over it, and scores the result against the ground truth the generator
recorded. The recogniser is a `Predict` seam, so the same harness scores oemer today and the bespoke
engine later (ADR-0005). It prints a table and appends one line to `eval/history.jsonl` per run.

> **RAM.** The oemer worker holds a ~7 GB model (V9). On a small machine (e.g. 8 GB, earlyoom) the
> run can be OOM-killed — that is a datum for v0.3, not a bug (ADR-0031 exists partly because of it).
> Use `--engine fixture` to exercise everything but oemer, and run the real oemer baseline on a bigger
> host — or **on a rented pod without one**: `rp eval-onpod` (ADR-0032, KAN-1379) recognises the corpus
> on the pod and scores it locally through `--engine dump`, avoiding both the RAM wall and the
> WAN-request failures the ADR-0032 gate hit (see `tools/runpod/README.md`). To score a **real** engine
> on a small host, serve the low-RAM heuristic engine (V13c, OpenCV
> only) and point the worker path at it — `SIBEI_OMR_ENGINE=heuristic python -m sibei_omr.server`, then
> `pnpm eval --engine worker`. Its accuracy is modest by design; the value is a real end-to-end number
> without oemer's RAM.

## The metrics

All are alignment-based, because a recognised chart and the truth differ in length (a missed or
hallucinated note): LCS gives the order-preserving matches behind precision/recall/F1, Levenshtein a
symbol error rate. Defined in `packages/synth/src/metrics.ts`, tested on empty/perfect/off-by-one.

| Metric | What it means |
|---|---|
| **noteF1** | F1 over the note/rest sequence — pitch **and** rhythm must match. The headline number. |
| **noteAcc** | matches / max(pred, truth) — one scalar, easier to read than P/R/F1. |
| **chordF1** | F1 over chord symbols, compared after canonicalising through the V5 grammar (`CM7` == `Cmaj7`). V13 added chord recognition (PaddleOCR on the cropped band + the V5 corrector + stage-3 beat mapping), so this now moves: the heuristic engine scores it end-to-end on a small host (a real 0.100 on the synthetic corpus at V13d), and oemer's chord baseline — the ADR-0011 stage-2 fine-tuning target — is measured on a bigger host, since oemer OOMs here. |
| **validBars** | Fraction of bars that are metrically valid (ADR-0013). *Empty bars count as valid*, so read it alongside noteF1, not alone. |

The synthetic corpus is scored per degradation level (`clean`, `light`, `medium`, `heavy`) so the
harness's sensitivity is visible: a degraded corpus must score below a clean one, or the harness is
not measuring what it claims. The `real` row is the hand-labelled control set
(`tests/fixtures/eval/real/`, see its README) — the gap between it and `clean` is the
synthetic→real gap every training decision has to respect.

## Performance metrics (speed + RAM)

Accuracy is only half of what decides the v0.3 engine swap. ADR-0031 makes **peak RAM** a
first-class gate metric — escaping oemer's ~7 GB is half the reason the bespoke engine exists — and
the maintainer added **speed**, because a smaller model is a faster one and latency is what a user
feels. So the harness reports three axes, not one: accuracy (above), speed, and footprint.

| Metric | What it means |
|---|---|
| **sec/page** | Wall-clock seconds to recognise one page, single recogniser call. Sourced from `OmrDocument.source.wallClockSeconds`, which the worker already records. |
| **peakMB** | Peak resident memory (RSS) during one recognition, in MB. Measured worker-side (`resource.getrusage`/`psutil`) and carried on `OmrDocument.source` (a schema addition when the bespoke engine lands). oemer ~7 GB; the bespoke target is comfortably under an 8 GB machine. |
| **weightsMB** | Static size of the baked model weights on disk — a cheap footprint proxy, reported once per engine, not per page. |

**Speed is only honest measured thread-pinned.** oemer's wall-clock is distorted by onnxruntime
**thread over-subscription** — on a pod that reports ~128 host cores it spawns far more threads than
the vCPU allocation and *slows down* (`pthread_setaffinity_np failed …`, ADR-0032 finding 2). A
sec/page compared across engines under different thread counts is meaningless. So both engines are
timed under a **fixed thread budget** (pin `OMP_NUM_THREADS` / onnxruntime intra-op threads to a
small, stated number, e.g. 1–2), reflecting the CPU-first deployment floor (ADR-0025). The number is
a floor to beat, not a peak to brag about.

**Measure speed and RAM in the CPU inference environment, never on the GPU training pod.** Training
compute is a RunPod GPU pod (ADR-0031 / ADR-0032); the *gate* is what ships — CPU inference, thread-
pinned — so the perf numbers are taken there. A GPU training run says nothing about the shipped
footprint.

These columns join the accuracy table `make eval` prints and each `eval/history.jsonl` row, so a
change to the recogniser moves accuracy, speed and RAM together and a regression in any one is
visible.

## The human-time ship gate

Accuracy is necessary but not sufficient: import ships when a person can **correct** a real chart
faster than they could retype it. That is a stopwatch test, written here so it is repeatable rather
than a vibe (Q42).

**Procedure.**

1. **Fixture.** A named 32-bar head, photographed once and kept: `tests/fixtures/eval/real/gate-32.*`
   (a real photo, medium difficulty — not the worst, not staged-perfect). Its ground truth is
   `gate-32.json`.
2. **Setup.** A fresh import of the fixture photo, opened in the browser split view (V14), with the
   flagged/low-confidence marks showing. Stopwatch ready.
3. **Task.** A musician corrects the imported draft until it matches the printed chart — every pitch,
   rhythm, chord and barline. "Corrected" means: `sbscore show` of the result equals the ground truth
   modulo ids, and the corrector agrees it is right by eye.
4. **Measure.** Wall-clock from opening the draft to declaring it corrected. Record it, the date, the
   git SHA, and the `make eval` numbers of that build, in the same `eval/history.jsonl` spirit.
5. **Gate.** Import passes when a 32-bar head is correctable in **≤ 2 minutes**. Above that, importing
   is not yet faster than typing and the pipeline is not ready to ship (Q42).

Run this at V14 (the correction UI) and again whenever the recogniser changes materially — a v0.3
engine swap included. A faster `make eval` number that does not move the stopwatch has not shipped
anything a user feels.

### Running it against the V14 correction surfaces

V14 is the slice that first makes this gate runnable, because the correction UI it describes in step 2
now exists. Concretely, with the worker running:

1. **Import.** `sbscore import tests/fixtures/eval/real/gate-32.jpg` (or drop the photo into the
   library's import affordance). The runner recognises it, maps it to a draft `Score`, and returns the
   new score id.
2. **Open the review.** Open that score in the browser's split-pane review view (V14a): the retained
   scan sits beside the recognised score, both scrollable and zoomable (ADR-0019).
3. **Correct.** Work the flagged spots down to zero, using every V14 surface:
   - confidence highlighting and invalid-bar shading (V14b/c) to see *where* the recogniser was unsure
     or produced a metrically-invalid bar (ADR-0013, ADR-0019);
   - the `!` review flags in `sbscore show`, so the CLI and the browser point a human — or an agent — at
     the same objects;
   - the no-sections advisory (V14d), since layout silently depends on sections and import never detects
     them (ADR-0021), so a genuine rehearsal mark is promoted here;
   - chord and note editing on either surface;
   - `sbscore reparse <id> [--engine …]` (V14e) as the escape hatch when a draft is more wrong than it
     is worth patching — it re-runs the pipeline from the *retained* scan (no re-upload) and produces a
     **new** draft, optionally under a different engine, which you then correct instead.
4. **Measure.** Wall-clock from opening the draft to declaring it corrected — "corrected" as defined
   above: `sbscore show` of the result equals the ground truth modulo ids and the corrector agrees by
   eye. Record the elapsed time, the date, the git SHA, and that build's `make eval` numbers, in the
   `eval/history.jsonl` spirit.
5. **Gate.** **Pass iff a 32-bar head is correctable in ≤ 2 minutes** (Q42). Above that, importing is
   not yet faster than typing and the pipeline is not ready to ship.

### Result — DEFERRED (V14f)

The stopwatch run is **not yet taken**, and no number is recorded here or in `eval/history.jsonl`,
because the gate's inputs are not present on the build hosts:

- **The fixture is absent.** `tests/fixtures/eval/real/gate-32.*` does not exist — the real-photo
  control set ships empty by design (see `tests/fixtures/eval/real/README.md`: a fabricated "real" photo
  would defeat the purpose). Without a real scan *and* its hand-verified ground truth there is nothing
  to correct *to*, so the "corrected == ground truth" test in step 4 cannot be run.
- **The engine that reads a real scan needs a bigger host.** oemer (the default engine) peaks at ~7 GB
  and is OOM-killed on the 8 GB / earlyoom build host (V9, V12 note, ADR-0031 — this is the RAM premise
  v0.3 exists to address, not a bug). The low-RAM heuristic engine (V13c) runs here, but it is dev/test
  scaffolding whose accuracy is modest by design; the gate is a statement about correcting a *real*
  photograph with the shipping engine, so measuring it on the heuristic engine would not answer it.

Recording a fabricated time would defeat the same purpose the empty control set protects, so the
measured run is deferred rather than faked.

**To run it, produce and commit the gate fixture, then take the stopwatch on a host with the memory to
run oemer:**

1. Photograph a real 32-bar head once — medium difficulty, not the worst, not staged-perfect — and
   commit it as `tests/fixtures/eval/real/gate-32.jpg` (`.jpeg`/`.png` also accepted).
2. Transcribe it correctly by hand (or import-then-correct) and commit the acceptable lead sheet as its
   ground truth, `tests/fixtures/eval/real/gate-32.json` (a `Score` document, the shape
   `sbscore open <id> --json` prints).
3. On a host with ≥ ~8 GB free for the worker, run the procedure above and record the elapsed time,
   date, git SHA, and that build's `make eval` numbers — here in this section and as an
   `eval/history.jsonl` row, the same convention every other run follows.
