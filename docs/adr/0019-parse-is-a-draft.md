# ADR-0019: Every parse is a draft — correction is the primary import experience

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

`REQS.md` records this as an unverified belief: "Optical music recognition on a
phone photo is the riskiest part of the whole product, and it will not be perfect.
The product should probably treat every parse as a draft that a human corrects, not
as a finished import, and the UI should be built around that assumption from the
start."

The interview confirmed and operationalised it.

## Decision

Import produces a draft, and correcting it is the primary import experience rather
than an error path.

- The source image is stored **permanently** alongside the score, and displayed
  beside the rendered result, scrollable and zoomable.
- Low-confidence objects and metrically invalid bars are **highlighted** on screen
  and carry the same `!` flag in the text projection (ADR-0009), so the human and
  the agent are pointed at the same doubtful places.
- Confidence is best-effort per object type: chord confidence comes cheaply from OCR
  scores; note and rhythm confidence from oemer is patchier; metric validity
  (ADR-0013) is derived and reliable regardless of engine.

Hand-correction is the accepted answer for the notation OMR gets least reliably —
ties and triplets especially — rather than a reason to narrow the feature.

## Consequences

- Keeping the image forever also means a chart can be **re-parsed later by a better
  engine**, which makes the staged OCR plan (ADR-0011) and any future engine change
  retroactively valuable across the whole library.
- Confidence must be plumbed from the Python worker through the model to both the UI
  and the text projection. It is a field on model objects, not a transient
  pipeline detail.
- Undo (ADR-0003) matters more than it would otherwise: correcting a bad parse
  without undo is genuinely unpleasant.
- No guided bar-by-bar review queue in the MVP. Flags plus side-by-side is judged
  enough; a review queue is additive if correction throughput turns out to be the
  bottleneck.
- Because sections and barline types are not detected (ADR-0021), the correction
  experience includes structural work, not just note fixing. The view should prompt
  when a score has no sections, since the four-bar layout (ADR-0015) silently depends
  on them.
- Blob storage grows with every import, since images are never discarded.
