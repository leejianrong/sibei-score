# V1: the render gate

The exit condition for ADR-0014: look at the PDF and decide, keep VexFlow or own the
engraver. This file records what was built, what turned up, and how it went.

**Status: decided, 2026-07-31 — own the engraver.** See
[ADR-0030](adr/0030-own-the-engraver.md). VexFlow's output was judged good, and the
decision went the other way anyway: jazz typography is this product's differentiator
rather than its polish, and 4.2.5 is the end of a line 5.x cannot continue server-side.
V1b is the spike that proves the approach and produces the estimate.

One thing this gate is worth remembering for: the defect it caught. Beamed notes were
drawing both their own flag and a duplicate stem, and 82 green tests plus a passing
snapshot did not notice. Someone had to look. That is why `pnpm proof` now exists and why
proofing is a required step in `CLAUDE.md`.

## What to look at

```sh
pnpm render:nasty      # writes out/nasty-chart.pdf
```

`out/nasty-chart.pdf` — one A4 page, 19 bars plus a pickup, 5 systems. Also
`out/every-glyph.pdf` (every item kind the layout contract can emit) and
`out/invalid-bars.pdf` (bars that do not sum to the meter, stored and drawn as written).

## What the fixture is deliberately awkward about

Each of these is in `nastyChart()` because getting it wrong is visible from a stand.

| Feature | Where |
|---|---|
| Four bars per line | throughout |
| An 11-bar section breaking 4 / 4 / 3 | section A, bars 1–11 |
| A pickup before bar 1, taking no grid slot | bar 0 |
| A tie across a plain barline | bar 13 into 14, mid-system |
| A tie across a system break | bar 4 into 5, and 8 into 9 |
| An eighth-note triplet (beamed, no bracket) | bar 3 |
| A quarter-note triplet (bracketed) | bar 10 |
| A double barline | end of bar 11 |
| A repeat pair | bar 12 start, bar 19 end |
| Accidentals contradicting the key signature | A♮, E♮, then B♮ followed by B♭ |
| Ledger lines above and below | C6 in bar 7, E3 in bar 8 |
| Two chords in one bar | bars 2, 4, 6, 10, 11, 13, 16, 17, 18 |
| Awkward chord spellings | `C7alt`, `F#m7b5`, `Bb13#11`, `Ab/Eb`, `N.C.` |

## Findings from building it

Three things worth knowing before judging the output.

### VexFlow 4, not 5

Pinned to **4.2.5**, the last of the 4.x line. VexFlow 5 changed how music glyphs are
drawn: 4.x emits every glyph as a filled `<path>`, while 5.x emits `<text>` in Bravura
and measures text through a canvas. Server-side that is a problem three times over — a
headless DOM has no canvas, so 5.x mismeasures and misplaces everything; the PDF would
need Bravura embedded and subsetted, which is a moving target for byte-stability; and it
adds a native dependency to a container that has to run offline on CPU alone.

4.2.5's path output needs no font, no canvas and no native code, and the geometry
converts to PDF exactly. The cost is being pinned to a frozen version — acceptable given
ADR-0014 already treats the renderer as replaceable behind the seam, and given that
reproducible output is a requirement rather than a nicety.

**This became part of why the gate went the way it did.** Staying on VexFlow means staying
on a dead branch, since 5.x cannot continue server-side. Recorded in ADR-0030.

### Text is placed by us, not by VexFlow

VexFlow centres text by measuring it with `getBBox()`, which only a real browser
implements. Measuring server-side would put the title and bar numbers in slightly
different places than the browser does, and ADR-0015 requires that screen and print
cannot drift. So the title block and bar numbers are written into the SVG with
`text-anchor`, where both environments agree by construction. Chord symbols and rehearsal
letters go through VexFlow, which sizes those from font metric tables rather than a
canvas.

### Chord symbols needed a layout decision to sit straight

VexFlow places a chord symbol at `min(the stave's top-text line, just above the note)`,
so a tall note lifts its symbol and the harmony comes out ragged. Reserving room for the
tallest note in each system makes the first term always win and the baseline comes out
flat. Working out how much room that is turned out to be a layout decision, not an
adapter one, so it lives in `packages/layout/src/vertical.ts` — which also means system
height is derived from the music rather than fixed, and a system with an E3 in it no
longer collides with the one below.

Accidental *selection* moved to layout for the same reason: which accidental a note draws
depends on the key signature and on what the bar has already altered, and any adapter
would need the same answer. ADR-0014 leaves VexFlow the stacking, which it still does.

## Known rough edges, for the judgement

Not bugs — choices worth a second opinion.

1. **Page density.** Five systems on A4 leaves the lower third of the page empty. The
   staff is 8.5 mm (`pointsPerUnit: 0.6`); Real Book charts run nearer 7.5 mm and fill the
   page. Systems are not spread vertically to fill. One knob, one policy decision.
2. **Justification.** Bar widths blend an equal share with a content-proportional one at
   `equalWeight: 0.64`. Higher reads as a stricter grid; lower gives a busy bar more room.
   Bar 6's four sixteenths are the tightest thing on the page.
3. **Chord distance from the staff varies between systems**, because it is derived from
   the tallest note in each. Flat within a system, which is the part that reads. Making it
   uniform chart-wide is a small change if it matters.
4. **Chord symbols are left-aligned to their note.** VexFlow's other option is centring on
   the notehead or the stem.
5. **Chord text is split, not parsed.** The root is separated from the extensions so the
   extensions can be superscripted, but nothing understands the symbol yet. V5 replaces
   the split with the chord grammar (ADR-0012), which is also where `Δ`, `ø` and proper
   `alt` typography would come from.

## Verification

82 tests, covering the V1 test plan in `SLICES.md`.

- The nasty chart's A section lays out 4 / 4 / 3, and the pickup takes no grid slot.
- Rendering the same score twice gives byte-identical PDFs; dates and the producer string
  are pinned and VexFlow's element ids are stripped.
- Committed SVG snapshots for the nasty chart and the every-glyph chart.
- The adapter handles every item kind the contract declares, asserted against a fixture
  that emits all of them.
- Bars summing under, over and exactly to the meter classify correctly in 4/4, 3/4 and
  6/8, and invalid bars lay out and draw rather than being rejected.
- Grid: 1, 3, 4, 5, 8 and 11 bars; section boundaries breaking mid-line and not creating
  an empty system on a line boundary.
- `model` and `layout` import nothing framework- or Node-specific — checked by the
  compiler, the import graph, and the declared dependencies. The checks were confirmed to
  fail when violations were injected.
- A beamed note draws no flag, asserted with a control so the check cannot pass vacuously.
  This is the regression test for the defect the gate itself found.
