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
> Use `--engine fixture` to exercise everything but oemer, and run the real baseline on a bigger host.

## The metrics

All are alignment-based, because a recognised chart and the truth differ in length (a missed or
hallucinated note): LCS gives the order-preserving matches behind precision/recall/F1, Levenshtein a
symbol error rate. Defined in `packages/synth/src/metrics.ts`, tested on empty/perfect/off-by-one.

| Metric | What it means |
|---|---|
| **noteF1** | F1 over the note/rest sequence — pitch **and** rhythm must match. The headline number. |
| **noteAcc** | matches / max(pred, truth) — one scalar, easier to read than P/R/F1. |
| **chordF1** | F1 over chord symbols, compared after canonicalising through the V5 grammar (`CM7` == `Cmaj7`). Until V13 the pipeline detects no chords, so this reads ~0 for oemer — the baseline V13 must lift. |
| **validBars** | Fraction of bars that are metrically valid (ADR-0013). *Empty bars count as valid*, so read it alongside noteF1, not alone. |

The synthetic corpus is scored per degradation level (`clean`, `light`, `medium`, `heavy`) so the
harness's sensitivity is visible: a degraded corpus must score below a clean one, or the harness is
not measuring what it claims. The `real` row is the hand-labelled control set
(`tests/fixtures/eval/real/`, see its README) — the gap between it and `clean` is the
synthetic→real gap every training decision has to respect.

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
