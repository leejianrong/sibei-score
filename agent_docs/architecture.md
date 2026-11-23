# Architecture: the render path

The layout seam, the engraver, addressing, and the text-placement rule. Read this before touching
`layout`, `engrave`, or hit-testing.

## The layout seam

`layout(score, pageSpec) -> pages -> systems -> bars -> items`.

Layout owns everything **above** the bar: which bars go on which line, where each bar box
sits and how wide it is, how tall a system needs to be, page breaks, the title block, and
which accidental each note draws.

**Page 1's title band is derived from the rows the header actually drew**, not reserved
unconditionally (KAN-525). `buildHeader` emits a title only for a score that has one, a style line
only for a score that has one, a composer only for a score that has one — so it may emit nothing,
and it used to get an inch and a half of white anyway. Now `headerBand()` measures the ink: a chart
with no title block starts at `margin.top`, **exactly as a continuation page already did**, which
is the consistency that decided it over reserving a smaller band. `PageSpec.headerHeight` therefore
now means "what a *full* block wants", and what a given page reserves is derived from it. A
title-only chart sits 32 units higher than it used to; the `untitled` fixture is the case.

The adapter owns engraving **inside** a bar box: stem
direction, beam grouping, accidental stacking, tie curves, **and where in the box each
onset sits** — the contract says so in `packages/layout/src/items.ts`, and this file used to
leave that last one out.

If you find yourself computing a position *above* the bar in an adapter, it belongs in
`layout`. If you find yourself naming a glyph in `layout`, it belongs in the adapter.

`LayoutBar` publishes `prefixWidth` — the room the clef, key and time signature were
allocated — so an adapter knows where a bar's *music* starts rather than guessing. It was
added when there were two adapters and they disagreed. A repeat sign is still the
adapter's to make room for, which is the same gap one size smaller.

## Staves and voices in the layout (ADR-0041, SIB2-227)

A chart with one staff and one voice lays out exactly as it always has: none of the fields below appear. A score with
more than one staff, or a staff-bar with two voices that have music, takes the **staves path** (`isMultiLane`,
`packages/layout/src/lanes.ts`) and its `LayoutSystem` gains three optional fields. The contract slice 4's engraver
draws from:

- `LayoutSystem.bars` is still the **first staff's first voice**, with the chord row, rehearsal marks, bar numbers and
  tempo. `LayoutSystem.staves: LayoutStaff[]` lists every staff top to bottom: `staffId`, `partId`, `type`, `clef`,
  `staveOffset` (from the top staff line) and `staveY` (absolute, set at pagination), `height`, `inkAbove`/`inkBelow`
  (ledger-line room), `ties`, and `bars: LayoutStaffBar[]` (`prefix` = which of clef/key/time this staff draws at the
  bar head; `voices: LayoutVoice[]` with `index`, `stems` up/down/auto and `items`). Staff 0 voice 1's `items` is the
  same array as `system.bars[i].items`.
- **Alignment.** Every note, rest, chord symbol and annotation carries `x`; every item with the same onset in a bar,
  on any staff or voice, has the same x. `LayoutBar.alignment = { left, right, columns: [{onset, x}] }` is the
  source. Spacing is a damped function of rhythmic distance (`alignBar`), a pure function of the onsets and the bar
  box. A chord off every note's onset is interpolated between the columns around it.
- **Widths.** A bar is as wide as its widest staff's estimate, floored by the union of all staves' rigid widths
  (`sizingFor` handed to `allocateWidths`); `prefixWidth` is the same for every staff of a bar, so the first column
  starts at one x. Per-staff `prefix` differs only in that a percussion or tab staff draws no key signature.
- **Vertical.** `aboveStaff`/`chordBaselineOffset` are the top staff's: the chord and text row lives above the top part
  only. Each lower staff sits `max(STAFF_GAP (+PART_GAP between parts), ink above it reaches down + ink it reaches up +
  INK_CLEARANCE)` below the last; ink is read against the staff's own clef (`staffInk`, treble/bass/alto/tenor).
  `system.height` is the whole stack, so pagination and page breaks need no change.
- **Grouping.** `groups: LayoutStaffGroup[]`: a `brace` for each part with 2+ staves (a piano), one `bracket` across the
  system when there are 2+ parts (derived: the model has no explicit grouping yet). Each is a box (`x`,`width`,`y`,
  `height`), `x` its left edge, `y`/`height` from the first staff's top line to the last staff's bottom line.
  `staffSpan` is the vertical run a barline (and the system's left edge) makes across all staves.
- **System breaks.** `meta.layout` (`'lead-sheet'` default, or `'score'`; optional, so no migration, ADR-0028). `lead-sheet`
  is the four-bar grid of ADR-0015, unchanged, even for a multi-staff score. `score` breaks a line when the next bar
  (its rigid width over all staves, at least `minBarWidth`) would not fit; sections and `lineBreak` still apply. No op
  sets it yet.
- Per-part transposed keys, tabs' six lines and cross-staff beams are not modelled. The engraver draws all of it (below).

**How the engraver draws a staved system (slice 4, SIB2-228).** `engraveSystem` takes the single-staff path unchanged
unless `system.staves` is present, then `engraveStavedSystem` (`engrave.ts`): staff lines per staff (five, or one for
a percussion staff; a tab staff is five lines for now), the system's brace/bracket (`groups.ts`, filled paths inside
layout's boxes) and one **joined barline** per bar from `staffSpan` (`barlines.ts`'s `BarlineJoin`: one tall rect, repeat
dots still on each staff; a one-line percussion staff at either end shortens the run to a space either side of its
line), then one `engraveBar` call per voice of every staff, steered by a `BarMode`. `SINGLE_STAFF` is every field at the
value the engraver always had, which is what keeps a lead sheet byte-identical. The first voice of each staff carries
that staff's clef/key/time; only the top staff's first voice carries chords, text, rehearsal marks, bar number and the
invalid-bar wash. Notes sit on layout's `item.x` (`placeAligned`) rather than being spaced here. Clefs are
`signatures.ts`'s table (glyph + origin line); a position is `staffPositionIn(pitch, clef)`, a distance from the clef's
top line (`staff.ts`); a key signature in another clef is the treble pattern shifted and folded back onto the staff.
**Voices** (`voices.ts`): with two or more voices holding music, 1 and 3 stem up and 2 and 4 down (`stemsOf`), a rest
rides two half-spaces up or down (`restShiftOf`), and the later voice's head moves one head-width right where the heads
are a second or less apart, a pair that crossed, or a unison of different heads (`noteShifts`); a unison of the same head
is shared. Its accidental stays at the unmoved x. A single voice keeps the position-based stem rule exactly. Layout
measures the ink of forced stems too (`voiceStems` in `lanes.ts`, fed to `staffInk`), so the chord row clears an up stem.
Ties and slurs are drawn per staff from that staff's own anchors; ottava lines are the top staff's. A percussion note is
an x head (`percussionNoteheadFor`) on the one line, stems up. Seen with `pnpm proof <fixture>`: `grand-staff`,
`two-voice`, `lead-bass`, `full-band`, `voice-collisions`, `clefs-and-keys`, `staff-furniture`, each with a committed snapshot.

**See alignment without an engraver:** `pnpm layout:overlay [fixture] [--page N]` draws staff lines, groups, the barline
span, the aligned columns and every item's x as an SVG/PNG in `out/layout-overlay/`. Fixtures: `grand-staff`,
`two-voice`, `lead-bass`, `full-band` (`packages/fixtures/src/multi-staff-charts.ts`, built with `makeStaffedScore`).

## The engraver, and how the fonts get in

`packages/engrave` is framework-free like `layout` and `model`: it emits SVG **markup**
rather than DOM nodes, so it needs no `document` and no jsdom. Keep it that way — a test
deletes `globalThis.document` and renders anyway.

Its metrics are vendored, not derived. `packages/engrave/src/fonts/*.generated.ts` are
generated by `pnpm vendor:fonts` from pinned releases and are **not edited by hand**: 43
glyph outlines plus `engravingDefaults` per face, each cross-checked against a second file
of the same release before it is written. Bravura's outlines come from its own SVG font;
Petaluma ships only OTF, so `opentype.js` reads it — a devDependency that runs at
vendoring time and never ships. Licensing is in `packages/engrave/NOTICE.md` (SIL OFL 1.1
for both).

The rule that follows: **no tuning constants, and no font by name.** A stem's attachment
comes from the notehead's `stemUpSE` anchor, a flag's from its `stemUpNW`, every thickness
from `engravingDefaults` — and all of it through the `MusicFont` passed in, never imported.
A face is the reader's choice per render, because a lead sheet is read in a handwritten
Real Book face as often as an engraved one. If you find yourself nudging a number to make a
glyph look right, the anchor you want probably exists: `font.anchor()` throws for one the
font does not publish rather than returning zero, on purpose.

Within-bar spacing is the adapter's (`spacing.ts`). Two forces: what a duration asks for,
which grows with the *root* of the duration rather than in proportion to it, and what a
note's glyphs need whatever the tempo. Rigid glyph widths come out first and only the slack
is shared by time. A bar that does not fill the meter gets only its share of the slack, so
a short bar looks short rather than being justified into looking correct (ADR-0013).

## Addressing (ADR-0007)

`packages/model/src/address.ts`. Three forms, resolved server-side in one place so both
surfaces get identical semantics *and* identical error messages:

```
bar12.beat3    a beat within a bar. 1-based, fractional (bar12.beat2.5). bar0 is the pickup
bar12.n3       the third item in bar 12, by onset then by insertion order
note-17        a stable id
```

**Onsets only, and the error lists what is there.** A beat that is not an onset is a failure
carrying the bar's real onsets — `bar 12 has no note at beat 3; onsets are 1, 2.5, 4`. Never a
snap to the nearest thing: snapping lets an agent edit the wrong note and never find out. The
error is the feature.

Failures are structured (`AddressFailure`) with `formatAddressFailure` as the only place the
prose lives, because the API maps them to status codes, the CLI maps them to exit codes, and
both must print the same words.

Two entry points, and picking the wrong one is the easy mistake. `resolveAddress` is strict and
is what `set` and `rm` want. `resolvePosition` accepts a beat with nothing on it, because for an
`add` an empty beat is the entire point — and it will happily place a note past the end of the
bar, since ADR-0013 stores an invalid bar rather than refusing one.

**`nK` counts rests as well as notes.** ADR-0007 glosses it "the third note in bar 12", which
leaves open whether a rest takes a slot. It has to: a rest is a first-class object (Q35) and
would otherwise be unreachable by position. The narrower reading is recovered by the `kind`
argument — `resolveAddress(score, 'bar2.n2', 'note')` fails with `bar2.n2 is a rest, not a
note` rather than quietly editing the wrong thing. The text projection labels `nK` the same way,
which it must, because ADR-0009's whole design principle is that the projection prints the
addresses the CLI accepts — and there is a test that walks every printed address back through
the resolver and checks it lands on **the object printed beside it**, not merely that it
resolves.

## Never measure text

**Do not use `measureText` or anything that reaches `getBBox()`.** Only a real browser
implements them, so measuring would place text in one position on screen and another in
print, and ADR-0015 requires those cannot drift. Place text with SVG `text-anchor`
instead (`packages/engrave/src/text.ts`), and size a box from the font size and the
character count rather than from a measurement. `tests/arch` enforces this.

The same rule is why no music glyph is text: every one is a filled `<path>` taken from the
font's own outline, so nothing is embedded, nothing is subsetted, and the PDF bytes are
stable run to run. Keeping that property was a large part of why VexFlow 5 was never an
option (`docs/v1-render-gate.md`).
