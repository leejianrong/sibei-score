# ADR-0030: Own the engraver

- **Status:** Accepted
- **Date:** 2026-07-31
- **Deciders:** Jian, at the V1 render gate
- **Amends:** [ADR-0014](0014-vexflow-behind-draw-seam.md)

## Context

ADR-0014 chose VexFlow behind an explicit draw seam and put a spike gate on the
decision: render one deliberately nasty test chart and judge the output. V1 built that
and the gate ran (`docs/v1-render-gate.md`).

The gate found VexFlow's output **good** — readable off a stand, with the four-bar grid,
ties across system breaks, both triplet kinds, every barline type and dense chord
symbols all correct. It also found three things that bear on the decision:

1. VexFlow 4.2.5 is the end of the 4.x line, and 5.x cannot run headless without a
   canvas and an embedded font. Staying on VexFlow means staying on a dead branch.
2. A real defect was found **by eye, not by tests**: beamed notes drew both their own
   flag and a duplicate stem, because the adapter built beams after drawing the notes.
   Eighty-two green tests and a passing snapshot did not notice. The bug was an ordering
   interaction between two of VexFlow's own objects' draw lifecycles.
3. Jazz-specific typography — a handwritten Real Book face, `Δ`, `ø`, stacked
   alterations, parenthesised extensions, slash notation — is a **differentiator for
   this product**, not polish. It is the part a musician judges first, and it is the part
   VexFlow is least suited to.

Point 3 is what decided it. For a product whose quality *is* the look, the engraving is
not a dependency to be satisfied; it is the thing being made.

## Decision

**Own the engraver.** VexFlow is a starting position, not the destination.

Sequenced deliberately, because the estimate is not yet trustworthy:

- **V1b, next: the engraver spike.** Engrave one system from scratch — noteheads, stems,
  and beams for a bar of sixteenths — driven by Bravura's own
  `bravura_metadata.json` glyph anchors and engraving defaults. Put it **side by side**
  with VexFlow's output on the same music. Exit condition: look at both, confirm the
  approach is viable, and produce a real estimate for the rest.
- **The full replacement is scheduled after the spike, not before.** Its position in the
  slice order is chosen once V1b has given a real number. Building it before V2 would
  delay the editor, the store and the CLI by weeks against an estimate we have not
  tested, which is what ADR-0026 exists to avoid.
- **VexFlow stays in place behind the seam until the replacement reaches parity.** It is
  pinned to 4.2.5 and is not upgraded; 5.x is not usable server-side.

## Consequences

- ADR-0014's seam is what makes this affordable, and it holds: the replacement is a new
  implementation of the draw adapter, and `layout` does not change. Everything V1 learned
  about where the seam sits — that layout owns every decision and the adapter owns every
  glyph — carries over unchanged.
- **The regression harness already exists.** The committed SVG snapshots are the
  specification the new engraver must meet, and `pnpm proof --census` is the tool for
  reading the difference. That was not true when ADR-0014 was written, and it is a large
  part of why the decision is cheap now.
- Beams are the hard part and the main risk. Slope selection, adjusting every stem to
  meet the beam, secondary and partial beams, beams across rests, and the interaction
  with tuplet brackets. The single-voice constraint helps everywhere else — there is
  never a chord to stack accidentals within — but it does not help here.
- Bravura is SIL OFL 1.1 and ships machine-readable metrics, so glyph anchoring is solved
  data rather than research. This is the single biggest reason the estimate is weeks
  rather than months.
- The failure mode to watch is the one ADR-0014 named: not "broken" but "subtly
  amateur". A musician sees a bad beam slope immediately without being able to say why.
  The side-by-side in V1b exists specifically to expose that early.
- Rejected: **keeping VexFlow indefinitely.** The output is good enough to ship, and this
  was a genuine option — but it caps the product's ceiling at a general-purpose
  renderer's idea of a lead sheet, and leaves it on an unmaintained branch.
- Rejected: **replacing it immediately, before V2.** Weeks of engraving work before a
  single note can be edited, against an untested estimate.
