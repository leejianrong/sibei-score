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
articulations, ~~dynamics~~ (now in scope, see the SIB2-274 amendment), ornaments, grace notes, multi-staff and multi-part scores,
piano and drum notation, ~~lyrics~~ (now in scope, see the SIB2-273 amendment), collaboration.

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

## Amendment (SIB2-274, SIB2-273): dynamics, hairpins and lyrics are in scope

**Status:** Accepted, 2026-11-24. Reverses the exclusion of dynamics and lyrics.

**Why the exclusion no longer holds.** It was written for a lead sheet read off a stand by one player. The charts the
product now serves include vocal charts (a singer needs the words under the notes) and arranged parts (p, mf, crescendo
are what an ensemble reads), and neither is out of reach of the model: both are per-note or per-run marks that touch no
metric rule (ADR-0013). Both are supported and editable, not detected on import (as rehearsal letters), and nothing
plays from them (no playback exists).

**Dynamics.** `Note.dynamic?` and `Rest.dynamic?`, a `Dynamic` from the closed set `ppp pp p mp mf f ff fff sf sfz fp
rfz`, optional-and-absent so no stored document changes (ADR-0028, ADR-0041 additive). A dynamic is attached to the
note or rest it sits under, not to a bar position: it moves with its note (copy, transpose, move between staves) and
needs no onset arithmetic. No free text ("cresc.", "dolce"): a closed set is what lets MusicXML round trip it. Drawn
below the staff in the music font's own SMuFL glyphs (`dynamicForte`, `dynamicMF` and so on, vendored for both faces),
centred on the note. Stem direction does not move it: the row is below the staff, per staff on a multi-staff system.

**Hairpins.** A `Spanner` of `kind: 'hairpin'` in `Score.spanners` with `startId`, `endId` (notes, in reading order, as
slurs and ottava) and `hairpin: 'crescendo' | 'diminuendo'`. Two hairpins may not overlap (they share one row). Always
below the staff; no placement field. A wedge that crosses a system break is two halves, as a slur and an ottava line.
Where an end note carries a dynamic the wedge starts after the first note's dynamic and stops before the last note's.

**Layout.** One row under the staff (below the 8vb line when there is one), reserved only for a system whose staff has
a dynamic or a hairpin, so a chart without either lays out exactly as before and no existing snapshot moves. The row
holds its dynamics and wedges on one baseline (`dynamicsRow`, `DYNAMICS_*` in `vertical.ts`; the engraver places by the
same numbers). Lyrics (below) sit under this row.

**Operations.** `dynamic.set|rm` (target a note or rest), `hairpin.set|rm` (target the start note, `to`, `shape`); CLI
`sbscore dynamic set|rm`, `sbscore hairpin set|rm --cresc|--dim`; the browser's Selected panel (a Dynamic field on any
note or rest, a Hairpin field beside Ottava on a two-note selection); MCP reaches them through `batch`.

**MusicXML.** `<direction><direction-type><dynamics><mf/>` before its note and `<wedge type="crescendo|diminuendo|stop">`;
export and import round trip. A dynamic outside the closed set (`fz`, `pppp`, `other-dynamics`) is dropped with a named
warning. "dynamics were dropped" is no longer a lossy case.

**Lyrics (SIB2-273).** `Note.lyrics?: Lyric[]`, at most one `Lyric` per verse (1 to 4): `{ verse, text, syllabic:
'single' | 'begin' | 'middle' | 'end', extend?: true }`. An array on the note (rather than one field) so a second
verse needs no second model. A rest carries none. Drawn under the staff, centred under the note head, in a text face
(`LYRIC_*` rows below the dynamics row, one row per verse in use on the system); a `begin` or `middle` syllable is
followed by a hyphen centred between it and the next syllable of its verse, an `extend` line runs from the text to the
next note that has a syllable in that verse. Layout reserves the rows only for a system that has lyrics. Operations
`lyric.set|rm` (one syllable) and the bulk `lyrics.set <bar-range> "text with - hyphens"` that distributes syllables
onto the notes of the range (a rest is skipped, `_` is a melisma extender, `~` a skipped note); MusicXML `<lyric
number><syllabic><text><extend/>`. Wide syllables are not given extra bar width (layout allocates width from the music
alone, ADR-0015): a long word on short notes can crowd its neighbour, which is the same trade the chord symbols make.
