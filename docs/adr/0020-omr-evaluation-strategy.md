# ADR-0020: OMR evaluation — synthetic corpus, human-time ship gate

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

`REQS.md` flags that measuring OMR accuracy needs a corpus with hand-verified ground
truth and that building it is real work to be scheduled. There is also a copyright
problem: published lead sheets are copyrighted, so a corpus of photographed Real
Book pages is awkward to keep and impossible to share.

And "parsed correctly" needs a definition that can gate a release.

## Decision

**Corpus:** primarily synthetic. Render known MusicXML to images, then degrade them
— blur, skew, perspective, JPEG noise, shadow. Ground truth is free and exact, and
there is no copyright exposure. Supplemented by a small hand-labelled set of the
owner's own photos, which is what keeps the synthetic set honest about real fonts and
real degradations.

**Tracking metrics,** measured every run: note-level accuracy, chord-level accuracy,
and percentage of metrically valid bars.

**Ship gate:** a human-time target — a 32-bar head should be correctable by hand in
roughly two minutes.

## Consequences

- The synthetic generator is a real deliverable, and it is reused by the stage-2
  fine-tuning in ADR-0011. Building it for evaluation pays for itself twice.
- Separating tracking metrics from the ship gate matters: an accuracy percentage can
  look healthy while the errors cluster in one phrase, leaving the feature
  frustrating to use. The percentage tracks progress; the human-time target decides
  shippability.
- The synthetic corpus risks being systematically easier than reality — rendered
  notation lacks the quirks of real engraving and real paper. The small real-photo
  set is the control, and a growing gap between the two is a signal to invest in
  degradation realism.
- No corpus of copyrighted charts is retained or shared, and no corpus is built from
  user uploads should the app ever be hosted.
