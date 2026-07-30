# ADR-0018: Import accepts printed raster input only, through one pipeline

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

`REQS.md` says "take a photo or a PDF of a lead sheet and parse it." Two ambiguities
hid in that. A PDF may be digitally generated, with extractable vector paths and
embedded text, or a scan — genuinely different pipelines. And a photographed chart
may be printed or handwritten, which are very different recognition problems.

## Decision

**Raster only, one pipeline.** Photos (jpg/png/heic), scans, and PDFs rasterised to
images all take the same path. No vector or embedded-text extraction fast path.

**Printed and engraved charts only.** Handwritten manuscript is out of scope.

Supporting details: one chart may come from several images, applied in order, so a
two-page tune works; a single photo containing two different tunes is not supported
and the user crops. Preprocessing — deskew, perspective correction, crop to page,
contrast normalisation — happens automatically in the worker, with no interactive
crop UI. Partial results with flagged gaps are the normal failure mode; a hard error
only when no staff is detected at all. `sibei new` creates a blank chart, so the app
is fully usable with no import.

## Consequences

- One code path, one set of bugs, one evaluation corpus. A digital-PDF fast path
  would have given much better accuracy on that class of input — embedded text makes
  chord symbols exact with no OCR error at all — but it is a second pipeline to
  build, test and maintain, for a class of input that is not the motivating use
  case. It remains a clean later addition.
- Handwritten support would need different or fine-tuned models and its own corpus.
  oemer is not trained for it. Recorded as out of scope rather than as a gap.
- Automatic-only preprocessing means a genuinely bad photo is re-taken rather than
  rescued. Acceptable for a personal tool; a hosted version would likely want the
  crop UI.
- `sibei new` is needed for CLI/UI parity anyway, and it makes the app's value
  independent of OMR quality — a useful hedge given OMR is the dominant risk.
