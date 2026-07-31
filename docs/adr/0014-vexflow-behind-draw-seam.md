# ADR-0014: VexFlow behind a draw seam, with a spike gate

- **Status:** Superseded as to the renderer by [ADR-0030](0030-own-the-engraver.md);
  **the seam itself stands and is now the only adapter contract**
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Status update, 2026-07-31

VexFlow is gone. The gate this ADR set ran (`docs/v1-render-gate.md`), decided against it
(ADR-0030), and V1b–V1d replaced it; `packages/draw` and the `vexflow` dependency were
removed once `packages/engrave` reached parity.

**The part of this ADR that mattered turned out to be the seam, not the engine.** Because
`layout` owned every position and the adapter owned every glyph, swapping the renderer
touched no layout code, moved no note on the page, and left the committed SVG snapshots as
the specification the replacement had to meet. That is what made a decision this ADR
framed as "expensive to reverse" cost about a week. Everything below about the division of
labour still holds, with one word changed: read "the adapter" for "VexFlow".

## Context

The renderer choice was VexFlow, with the caveat *"based on how it looks I might
want to develop it on my own."* A concern was then raised that VexFlow cannot read
MusicXML — which ADR-0004 dissolves, since MusicXML is not the runtime truth and
some model-to-renderer mapping is required whatever engine is chosen.

That left the real question: use VexFlow, or engrave from scratch?

What VexFlow supplies: a bundled SMuFL music font with glyph tables and anchor
metrics; noteheads, stems and flags with correct stem direction and length; beam
grouping and slope; accidental stacking and collision avoidance; ledger lines; dot
placement; tie and slur bezier curves; tuplet brackets with numbers; rest glyph
selection by duration; clefs, key signatures with accidentals in the right order and
octave, time signatures; every barline type; and a `ChordSymbol` class that renders
jazz superscript extensions properly. SVG and Canvas backends, and it runs in Node.

What is ours regardless: the four-bar grid, justification policy, system and page
breaking, headers, the model, and all editing and hit-testing (ADR-0015).

## Decision

Ship on VexFlow, behind an explicit draw seam: the layout engine produces
engine-independent positions, and a draw adapter turns them into glyphs. The
VexFlow adapter is one implementation of that adapter.

Put a **spike gate** on it early in the build: render one deliberately nasty test
chart — four-bar grid, ties across barlines, triplets, a pickup, double barlines,
dense chord symbols including `C7alt` and `F#m7b5` — and judge the output. If it
fails, replace the draw adapter only.

PDF is produced by running the same VexFlow code server-side in Node to emit SVG,
then converting to PDF. Screen and print share one layout path.

## Consequences

- The decision is genuinely reversible, for two reasons. The seam confines a
  replacement to the draw layer. And a lead sheet is the easiest engraving target
  that exists — single staff, one voice, no dynamics, no multi-voice collisions — so
  owning the engraver later is perhaps 15% of a general engraver rather than the
  whole thing.
- Weeks of fiddly glyph work are deferred until there is evidence they are needed.
  The failure mode of hand-rolled engraving is not "broken" but "subtly amateur",
  which is exactly what a musician notices on a music stand.
- Exports are deterministic and therefore regression-testable. Tests snapshot the
  **SVG**, not the PDF bytes — PDF carries creation timestamps and producer strings
  that would make byte comparison flaky. PDF metadata is pinned to fixed values.
- Rejected: **headless Chromium print-to-PDF** — guarantees screen and print match
  by construction, but adds a browser to the image and makes byte-stable output
  harder. Rejected: **owning the engraver now** — total control of the look, at the
  cost of not seeing a chart render for weeks.

## Status update: the gate ran, 2026-07-31

V1 built the seam, the layout engine, the VexFlow adapter and the PDF path, and rendered
the nasty test chart (`docs/v1-render-gate.md`).

**Outcome: own the engraver** ([ADR-0030](0030-own-the-engraver.md)). Not because the
output was bad — it was good, and readable off a stand — but because jazz-specific
typography is a differentiator for this product rather than polish, and because VexFlow
4.2.5 is the end of a line that 5.x cannot continue server-side.

Three things this ADR got right and one it did not:

- **The seam was worth building.** It is exactly what makes the replacement affordable:
  a new draw adapter, with `layout` untouched.
- **The spike gate was worth putting on it.** The decision was made on a rendered page
  rather than on speculation, and the page turned up a real defect no test caught.
- **"A lead sheet is the easiest engraving target that exists" holds** — with one
  exception. Beams are the hard part, and they are hard in a way the single-voice
  constraint does not relieve.
- **What it missed:** that snapshots plus a proofing loop would become the specification
  for a replacement. That harness now exists, which lowers the cost of this decision
  well below what this ADR assumed.

VexFlow remains in place behind the seam, pinned to 4.2.5, until the replacement reaches
parity.
