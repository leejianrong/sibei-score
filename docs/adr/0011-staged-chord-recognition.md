# ADR-0011: Staged chord recognition — off-the-shelf OCR plus a grammar corrector first

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

The pipeline in ADR-0010 originally specified a text recogniser *fine-tuned
exclusively on a synthetically generated dataset of chord-symbol text*. That is
almost certainly the right end state — chord symbols are a tiny, highly
constrained visual language, and a model trained on nothing else should beat
general OCR comfortably.

But it is also a project inside the project: a synthetic data generator, a
degradation pipeline so the model transfers to phone photos, a training loop, a
checkpoint to ship in the image, and an evaluation harness to know whether any of
it helped. Shipping that as MVP scope delays the point at which the pipeline can be
measured at all.

## Decision

Stage it.

**MVP:** an off-the-shelf recogniser (PaddleOCR or EasyOCR) applied to the cropped
chord band, followed by a **chord-grammar corrector** that snaps recognised text to
the nearest legal chord symbol. Plus the evaluation harness (ADR-0020).

**Stage 2:** fine-tune on synthetic chord-symbol data, re-run the harness, and keep
the model only if the number actually moved.

The corrector is not a stopgap; it stays useful after fine-tuning. Chord symbols
have very few legal neighbours — a garbled `Cm7bS` has exactly one plausible
reading — so constraining output to the grammar (ADR-0012) fixes a large share of
OCR errors for very little work.

## Consequences

- The chord grammar becomes load-bearing: it is the error-correction mechanism, not
  merely a vocabulary. This is why it lives with the model in TypeScript
  (ADR-0005) rather than beside the OCR in Python — one implementation serves both
  import correction and validation of what a user or agent types.
- The evaluation harness must exist before fine-tuning, which is the right order:
  it makes stage 2 a measurable decision rather than an article of faith.
- The synthetic dataset questions — which fonts, what symbol grammar to enumerate,
  and which degradations (blur, skew, perspective, JPEG noise, paper texture,
  shadow) are needed for transfer to real photos — are deferred to stage 2 rather
  than answered now.
- Risk accepted: if off-the-shelf OCR on chord symbols is *very* poor, the MVP's
  chord accuracy may miss the ship gate and stage 2 becomes mandatory rather than
  optional. The harness will say so early.
