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

**Out of scope:** ~~D.S., D.C., segno, coda, Fine and To Coda~~ (now in scope, see the SIB2-175 amendment below); mid-chart time signature
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

## Amendment (SIB2-175): navigation marks are in scope

**Status:** Accepted, 2026-11-23. Reverses the exclusion of segno, coda, D.S., D.C., Fine and To Coda.

**Why the exclusion no longer holds.** It rested on two things: the marks are where OMR is poorest, and a chart is
"playable provided the form is written out". Real Real-Book pages (3 of the 8 in `docs/gap-inventory.md`, F15) use
D.S. al Coda, To Coda, Fine and D.C. al Fine, and recreating them by writing the form out changes the page, not
just its length. The marks are purely navigational, so the music stays fully represented and nothing about metric
validity (ADR-0013) changes. They are supported and editable, not detected on import (as rehearsal letters).

**The model.** `Bar.nav?: NavKind[]`, optional-and-absent so no stored document changes and `SCHEMA_VERSION` stays
(ADR-0028, ADR-0041 additive). `NavKind` is a closed set:

- sign kinds, drawn above the staff at the bar's **start**: `segno`, `coda`;
- jump kinds, drawn as bold italic text above the staff, right-aligned at the bar's **end**: `to-coda` ("To Coda"),
  `fine` ("Fine"), `dc` ("D.C."), `ds` ("D.S."), `dc-al-fine`, `dc-al-coda`, `ds-al-fine`, `ds-al-coda`
  ("D.S. al Coda" and so on).

The position follows from the kind, so it is not stored. A bar holds at most one of each kind and at most one jump
kind (two end texts would collide and mean nothing); it may hold a sign and a jump. The list is kept in a canonical
order. There is no free-text label: a closed vocabulary is what lets MusicXML round trip it and a future player
follow it. Playback-order expansion stays out of scope (no playback exists).

**Operations.** `nav.set` and `nav.rm`, addressed by `bar12` like barlines and endings; CLI `sbscore nav set|rm`;
a Navigation section in the browser's Structure panel; MCP reaches them through `batch`.

**MusicXML.** `<segno/>`, `<coda/>` in a `<direction-type>`, and `<sound segno= dacapo= dalsegno= tocoda= fine=/>`
with the printed `<words>`; export and import round trip, so navigation marks are no longer a lossy case.

**Consequences.** The "excluded navigation family" bullet above no longer applies. Layout reserves a band above the
staff (above the rehearsal row) for a system that carries a mark.
