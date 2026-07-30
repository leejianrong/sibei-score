# ADR-0010: Hybrid OMR pipeline on oemer, with chord recognition as its own subsystem

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

`REQS.md` names OMR on a phone photo as the riskiest part of the product. The
options offered were an existing engine (Audiveris or oemer), a vision model, or
building one. None was chosen. A specific three-stage design was supplied instead,
motivated by the observation that general OMR engines treat chord symbols as
incidental text while on a jazz lead sheet they are half the content.

## Decision

A three-stage pipeline, entirely local:

1. **Staff segmentation.** Locate each staff and crop the band directly above it,
   isolating the chord-text row from the notation. An object detection model or
   plain image processing.
2. **Chord text recognition.** Not general English OCR. A lightweight text
   recogniser applied to the cropped chord band only. Staging in ADR-0011.
3. **Beat mapping.** Take note and barline X-coordinates from the base OMR engine
   and align recognised chord bounding boxes to those exact beats.

The base OMR engine is **oemer**. Chosen over Audiveris because the whole pipeline
stays in one Python process sharing image arrays, the MIT licence keeps the hosted
future clean (Audiveris is AGPL), and — decisively — stage 3 needs pixel
X-coordinates, which Audiveris does not hand back: it emits MusicXML, which has no
coordinates at all.

No vision-model path, opt-in or otherwise. The runtime requires no network.

## Consequences

- Chord recognition is a first-class subsystem with its own accuracy metric, not a
  by-product of note recognition. This matches where the product's value is.
- oemer's known weak spots — complex rhythm and barline classification — are
  accepted, and are precisely where hand-correction (ADR-0019) carries the load.
  Barline classification was pushed further than that: **it is not attempted at all**.
  Import produces single barlines only, and double barlines, repeats, endings and
  section markers are hand-added (ADR-0021). A dedicated barline classifier stage —
  cropping each barline region oemer located and classifying it, mirroring the
  chord-band trick — was considered and deliberately not built for the MVP.
- Python is required, which drove the runtime split in ADR-0005.
- Stage 1's assumption is that chord symbols live in the band above the staff.
  Symbols placed elsewhere are missed in the MVP. Non-chord text found in that band
  ("Latin feel", section names) is retained as a flagged bar annotation rather than
  discarded; rehearsal letters are matched separately by pattern.
- The image is multi-gigabyte (Python, ML runtime, model weights). Accepted as the
  cost of local operation. CPU-only is a hard requirement; GPU is optional
  acceleration only.
