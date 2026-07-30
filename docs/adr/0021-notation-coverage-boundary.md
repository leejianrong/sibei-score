# ADR-0021: Notation coverage boundary

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

`REQS.md` fixes part of the notation surface: single staff with melody, chord symbols
above, bar numbers, key and time signature, accidentals, ties, triplet brackets,
double barlines. It leaves the rest of the jazz-chart vocabulary open, noting that
"leaving them out risks exporting charts a musician cannot read on a stand."

ADR-0015 then forced part of the answer: section boundaries drive line breaking, so
section markers must exist in the model whatever else is decided.

## Decision

**In scope:** single melody staff with explicit rests; chord symbols anchored to
beat positions within the bar; key signature and accidentals; one time signature per
chart; bar numbers; ties; triplet brackets; double barlines; **rehearsal letters and
section markers**; **repeat barlines with 1st/2nd endings**; **pickup bars** (bar 0).
Chart metadata: title, composer, key, and an optional style/tempo text line, all
OCR-attempted on import and editable from both surfaces.

**Out of scope:** D.S., D.C., segno, coda, Fine and To Coda; mid-chart time signature
changes; and everything `REQS.md` already excluded — playback and audio,
articulations, dynamics, ornaments, grace notes, multi-staff and multi-part scores,
piano and drum notation, lyrics, collaboration.

**Detected on import vs supported in the app** — these are now different lists.
Import produces notes, rests, ties, triplets, chord symbols, key and time signature,
and **single barlines only**. Double barlines, repeats, endings, section markers,
rehearsal letters and pickup identification are **supported, rendered and editable
but not detected**; the user adds them. This supersedes `REQS.md`'s claim that
double barlines are "detected on import".

**Page setup:** A4 and Letter, A4 default. A chart flows onto further pages when it
does not fit; no attempt to squeeze a long tune onto one page.

## Consequences

- A chart is playable off a music stand provided the form is written out. That is
  the bar this boundary is set to clear.
- The excluded navigation family (D.S., codas, segno) is where OMR accuracy is
  poorest and the correction burden highest, so excluding it removes cost from both
  the pipeline and the user. It is also purely navigational — the music is fully
  represented without it, just written out longer.
- Section markers were pulled in by layout, not by notation. Worth noting because it
  is the one place where a rendering convention dictated the model.
- Explicit rest objects are required by metric validation (ADR-0013).
- Because section boundaries drive line breaking (ADR-0015) and sections are not
  detected, **a freshly imported chart lays out on a plain four-bar grid and its line
  breaks will be wrong until the user adds sections.** The correction view should
  prompt when a score has no sections, or the first export of an import will quietly
  be mislaid.
- Adding D.S./coda later means new model objects, new detection, new rendering and
  new layout rules — additive, but not trivial.
