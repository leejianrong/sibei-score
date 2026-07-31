# V1b: the engraver spike

The exit condition for [ADR-0030](adr/0030-own-the-engraver.md): engrave one system from
scratch off Bravura's own metrics, put it beside VexFlow's on the same layout, and come
back with a real estimate.

**Status: gate passed, 2026-07-31.** The approach is confirmed and the anchoring design is
approved. What follows is the evidence, the estimate, and — at the end — what Jian decided
and the two requirements the review added.

## What to look at

```sh
pnpm proof nasty-chart --bar 6 --compare      # the demo: bar 6, both engravings
pnpm proof nasty-chart --bar 8 --compare      # ledger lines and the middle-line stem
pnpm proof nasty-chart --system 2 --compare
pnpm proof nasty-chart --engraver             # the whole page, ours only
```

`--compare` stacks both renderings of the **same crop of the same `LayoutResult`** at the
same scale, so every difference in the image is a difference in engraving. That is
asserted, not assumed: `tests/integration/engrave-seam.test.ts` renders one layout
through both adapters and checks they agree on the y of all twenty-five staff lines.

## What was built

`packages/engrave` — a second draw adapter behind the same seam, 1,100 lines, no VexFlow.

**Scope is one note and everything attached to it**: noteheads, stems, flags, ledger
lines, beams, accidentals and augmentation dots, plus the staff lines to read them
against. Nothing else. The boundary is drawn there because it is the one boundary that
does not produce misleading images — a dotted half without its dot is a half note, and a
proof of that would be a lie.

Everything the contract can emit and the spike does not draw is **counted by kind and
reported**, so no image can imply coverage that is not there:

```
the engraver drew notes only; it passed over: chordSymbol x28, endBarline x20, clef x5,
keySignature x5, barNumber x4, rehearsalMark x2, tupletBracket x2, rest x2,
timeSignature x1, barline x1
```

### Bravura arrives as data, and that is the whole finding

`scripts/vendor-bravura.ts` generates `packages/engrave/src/bravura.generated.ts` from the
pinned `bravura-1.392` release: the `engravingDefaults` table and the metrics and outlines
of fifteen glyphs. 12 KB. It is checked in rather than fetched, so `pnpm install` stays
offline (ADR-0027) and the data is auditable in review.

Three sources, because they cross-check each other:

| Source | Gives | Licence |
|---|---|---|
| `bravura_metadata.json` | anchors, bounding boxes, advance widths, `engravingDefaults` — in staff spaces | SIL OFL 1.1 |
| `Bravura.svg` | the outlines, as SVG path data in font units. An SVG font needs no font parser | SIL OFL 1.1 |
| SMuFL `glyphnames.json` | name to codepoint, so nothing is transcribed by hand | read at vendoring time, not redistributed |

Every glyph is verified across two of them before it is written: the advance width the
metadata states in staff spaces must equal the advance width the SVG font states in font
units. A codepoint that resolved to the wrong glyph fails there rather than in an image.

**The assumption V1b was built to test held.** ADR-0030 asked whether Bravura's metadata
is sufficient to anchor stems and beams without hand-tuned per-glyph offsets. It is.
`packages/engrave/src/bravura.ts` has no tuning constants in it. A stem's x and y come
from the notehead's own `stemUpSE` / `stemDownNW`; a flag is positioned by putting its
`stemUpNW` where the stem ends; every thickness — staff line, stem, beam, beam gap, ledger
line, ledger extension — is a value read out of `engravingDefaults`. The unit test asserts
the anchor claim against the font's numbers rather than against remembered ones, at every
staff position.

Outlines are placed by transform rather than by rewriting path data, so the vendored
outline stays byte-identical to the font's. That avoids owning a path parser and avoids a
copy of Bravura that quietly stops matching Bravura.

### Two things came out better than expected

**No DOM.** The engraver emits markup, not DOM nodes, so `packages/engrave` needs no
`document`, no jsdom and no renderer — it is as framework-free as `layout` and `model`,
and the architecture test now holds it to that. `@sibei/draw` cannot do this: VexFlow
builds elements with the global `document`, which is why `packages/pdf` installs jsdom.
A test pins it by deleting `globalThis.document` and rendering anyway. If the replacement
lands, the server-side render can drop a headless DOM entirely.

**Beams were not the hard part.** ADR-0030 named them as the main risk. They took an
afternoon and 190 lines, and the result reads correctly at bar 6, at bar 3's triplet and
at bar 18. The reason is that only one of the four decisions is genuinely hard, and it is
a *policy* decision with a published answer rather than a research problem:

1. Direction for the group — the note furthest off the middle line.
2. Slope — Gould's slant table by outer interval, plus a ceiling on the gradient.
3. Position — anchor the beam on the note nearest it, which fixes every stem length at
   once and makes "no stem is shorter than standard" true by construction rather than by
   a corrective pass.
4. Which beams over which notes — runs of consecutive notes per level, stubs for runs of
   one.

The V1 defect that started all this cannot recur here by construction: geometry is
computed in full and every stem end rewritten from its beam **before** any ink is
emitted, so no note is ever asked twice whether it is beamed. There is a test for it, with
the same lone-eighth control the VexFlow one uses.

### One real bug, found by eye and not by tests

The first version stemmed a note **on** the middle line upward. Both directions look
plausible; only down is conventional. Twelve green tests did not care, and it was obvious
the moment bar 8's Bb4 sat next to VexFlow's. This is the second time on this project that
the side-by-side or the proof image found what the suite could not — it is why `pnpm proof`
exists, and it is now a named case in `stems.ts` and an assertion in the unit test.

A second one, in the proofing tool rather than the engraver: the first `--compare`
implementation lifted each SVG's inner content into a nested `<svg>` and dropped the root
element, which silently deleted every stem and barline from VexFlow's panel — VexFlow puts
`fill`, `stroke` and `stroke-width` on the root and lets everything inherit them. Visible
immediately in the image.

## What the comparison shows

Bar 6 — four sixteenths with a natural on the second, the hardest beaming case in the
fixture and where V1's bug lived.

**Where the two agree**, to the pixel or near it: staff position of every note, ledger
line count and placement, stem direction, stem length, flag shape and attachment,
accidental glyph choice, and beam count. Bar 8 is essentially indistinguishable between
the two engravings apart from horizontal placement.

**Where they differ, and why:**

| Difference | Cause | Verdict |
|---|---|---|
| Our noteheads sit further left in the bar | no prefix width in the contract, see below | seam gap, fixable |
| Our four sixteenths are crammed into the first quarter of the bar | spacing is proportional to time and nothing else | out of scope, and the largest remaining item |
| Our natural collides with the previous notehead | the same: no allowance for an accidental's width | same |
| Our beam slants less than VexFlow's | deliberate — Gould's slant table caps a fourth at half a space; VexFlow's slant is about 2.2 spaces | **a typography call, question 4 below** |
| Our stems are marginally thinner | Bravura says 0.12 spaces; VexFlow draws 0.15 | ours is the font's number |

Nothing in the "subtly amateur" category that ADR-0014 warned about — the parts a musician
reads first (stem direction, stem length, ledger lines, beam thickness and separation) come
straight from the font or from a cited convention. The one thing that does look amateur is
the spacing, which is the part deliberately not built.

## The seam gap this surfaced, and the contract change that closed it

Within-bar spacing **is** the adapter's job, by the division of labour the layout contract
itself states (`packages/layout/src/items.ts`, ADR-0014): layout hands over the bar's box,
and the adapter decides where in it each onset goes. So the spacing code is in the right
package. `CLAUDE.md` had dropped "note spacing within the box" from its summary of that
split; the code is right and the doc has been corrected.

But **the prefix width was not published, and it had to be**. `layout/src/widths.ts`
already computes how wide the clef, key signature and time signature are — it sizes every
bar around them — and then kept the number private. An adapter that wants to know where a
bar's *music* starts had to guess it a second time. It cannot be worked out from anything
else, either: it is layout's own allocation, not a measurement of any font's glyphs.

**Decided at the gate and done in this slice:** `LayoutBar.prefixWidth`, one number per
bar, with `tests/unit/prefix-width.test.ts` behind it.

Worth being precise about what that bought, because the picture barely moved: the spike
had been guessing with a *copy of layout's own constants*, so the two agreed already by
coincidence. What the change removes is the duplication — the next person to touch
`widths.ts` no longer silently breaks an adapter. The residual gap against VexFlow is a
different thing: VexFlow draws real clef and key-signature glyphs that are wider than
layout's rough allocation, and adds its own formatter padding on top. Once our engraver
draws those glyphs itself it will draw them *inside* the allocated width, so it will be
self-consistent where VexFlow never was.

## The estimate

Measured basis: the spike is **1,100 lines of engraver, 464 lines of test, 31 tests, one
day**, and it covers the metrics foundation plus the item ADR-0030 called the main risk.
The whole VexFlow adapter is 589 lines and covers all thirteen item kinds, so line counts
are not the unit — comment density here is high and the remaining work is not uniform.

In units of "one spike":

| Remaining work | Size | Notes |
|---|---|---|
| **Within-bar spacing engine** | 1.5–2 | Glyph-width aware, accidental allowance, minimum distances. The schedule risk, the thing that decides whether the output looks professional, and the first thing the review asked for |
| Chord symbols | 1 | Interlocks with V5's chord grammar (ADR-0012); needs text advance widths, since `measureText` is forbidden (ADR-0015) |
| Rests, clefs, key and time signatures, barlines, voltas, tuplet brackets and digits | 1.5 | Mechanical and data-driven: more glyphs, more `engravingDefaults`, no new problems |
| Ties and slurs | 0.5 | Bézier from `tieEndpointThickness` / `tieMidpointThickness`; half-ties across system breaks already exist in the contract |
| Title block, bar numbers, rehearsal marks | 0.25 | `text.ts`'s `text-anchor` approach carries over unchanged |
| Parity harness: census diff against the committed snapshots, switch the PDF path, retire the VexFlow adapter | 0.5 | The snapshots are the specification and already exist |
| Font seam, so a face is chosen per render rather than per build | 0.5 | Added at the gate. Cheap first, expensive last — see below |
| Petaluma vendored and proofed as the jazz face | 1 | Needs a font parser at vendoring time, because Petaluma ships no SVG font |
| **Total** | **6.5–7.5** | |

**So: 6.5–7.5 focused days to parity.** That is ADR-0030's "weeks rather than months", now
with a basis under it. Two caveats on the number, both stated rather than hidden:

- **The risk moved.** It is no longer beams, it is spacing. Beams are bounded by published
  convention; spacing is a judgement problem with no single right answer, and it is the
  part where "correct but subtly amateur" lives. If the estimate slips, it slips there.
- **Chord symbols are not really the engraver's to schedule.** Their typography — `Δ`, `ø`,
  stacked alterations, parenthesised extensions — is what ADR-0030 called the
  differentiator, and it depends on V5's grammar. Parity with VexFlow's chord symbols is
  cheap; being *better* than them is the actual goal and belongs with V5.

Accidental stacking, which any general-purpose engraver has to solve, is **free** here:
single voice throughout (ADR-0021) means there is never a chord to stack within.

## Deliberately not done

- **No committed SVG snapshot of the engraver's output.** The snapshots of record are
  VexFlow's, because they are the specification the replacement has to meet (ADR-0030).
  Freezing the spike's geometry now would turn every deliberate refinement in the next
  slice into snapshot churn. Unintended change is caught instead by counted assertions —
  61 noteheads for 61 notes, 7 beam segments, exactly 1 flag, 25 staff lines agreeing with
  VexFlow — which is what actually needs to hold.
- **The engraver is not wired into the PDF path.** `pnpm render` and `pnpm proof --pdf`
  still go through VexFlow, unchanged, and the V1 PDF is byte-identical. The spike is
  reachable only from `pnpm proof --engraver` and `--compare`.
- Everything in ADR-0030's exclusion list: rests, ties, tuplet brackets, accidental
  stacking, clefs, key and time signatures, barlines, chord symbols, within-bar spacing.

## The gate outcome

Jian, 2026-07-31.

| Question | Decision |
|---|---|
| Glyph-anchoring design | **Approved as built.** Vendored slice from the pinned release, outlines placed by transform, every metric from `engravingDefaults` and the glyphs' own anchors, no per-glyph tuning |
| Beam slant | **Gould's conservative table**, which is what the spike does. The steeper VexFlow slant is not the house style |
| Published prefix width | **Yes, one number per `LayoutBar`.** Done in this slice |
| Estimate and sequencing | Time is not the constraint; a recommendation was asked for rather than a number accepted. See below |

ADR-0030's exit condition is met: the approach is confirmed, the anchoring design is
agreed, and the estimate has a basis under it.

### Two requirements the review added

**1. The sixteenths are too squished, and an accidental needs room of its own.** Which is
the spacing finding above, confirmed by the first person to look at it who was not the
author. It moves spacing from "the largest remaining item" to "the item the replacement
starts with", and it adds a specific acceptance test: the natural in bar 6 must not touch
the note before it.

**2. The final output must be renderable in a jazz face or a normal one, at the reader's
choice.** This is new, and it lands on the design that was just approved, so it is worth
being precise about what it costs.

It is feasible on the same terms. Steinberg publishes **Petaluma**, a handwritten SMuFL
face, under SIL OFL 1.1, and its `petaluma_metadata.json` has exactly the shape the
vendoring script already reads — the same six `engravingDefaults`, `stemUpSE` and
`stemDownNW` on `noteheadBlack`, `stemUpNW` on the flags. The numbers differ from
Bravura's, which is the point: Petaluma's `stemUpSE` is `[1.336, 0.288]` against Bravura's
`[1.18, 0.168]`, so a hand-tuned offset would have been wrong for it and an anchor is
right for both. The approach transfers unchanged.

Two things it costs:

- **Petaluma's redist ships no SVG font**, only OTF and WOFF, so its outlines cannot be
  lifted the way Bravura's were. The vendoring script needs a font parser — `opentype.js`
  or equivalent, a *vendoring-time* devDependency that never enters the product, so
  ADR-0027's register is unaffected.
- **The engraver currently reads one module-level font.** `INK` and the glyph table are
  module constants that `staff.ts`, `stems.ts` and `beams.ts` import directly. Choosing a
  face *per render* means threading a font object through about eight geometry signatures.
  It is mechanical and small — half a day — but it is much cheaper before parity than
  after, so it belongs at the **start** of the replacement rather than at the end.

Note for the record: this requirement does not on its own force the replacement. VexFlow
4.2.5 ships Petaluma glyph outlines too. What it cannot give is the rest of a Real Book
page — `Δ`, `ø`, stacked alterations, parenthesised extensions, a handwritten face for the
chord symbols and title — which is exactly what ADR-0030 called the differentiator.

### Revised estimate

Add half a day for the font seam and one day for Petaluma's vendoring and proofing, and
subtract nothing: **6.5–7.5 focused days to parity with a working jazz/normal switch.**

### Sequencing: the recommendation

Time is not the constraint here, so the ordering question is not "what is cheapest" but
"what retires the most uncertainty soonest". `SLICES.md` already establishes that V1b and
V2 touch nothing in common and can run in either order.

**Recommended: spacing next, as its own small slice, then V2, then the rest of parity.**

- **Spacing next.** It is the only genuinely uncertain item left — everything else on the
  table is mechanical, data-driven glyph work. It is also the thing the first reader who
  was not the author objected to. A day and a half now, against an engraver that is 1,100
  lines and still small enough to hold in one's head, retires the whole schedule risk.
  Do the font seam in the same slice, for the same reason: it is half a day while the
  geometry has eight signatures and considerably more once it has thirty.
- **Then V2.** Nothing about the store, the op log or the API depends on the renderer, and
  the product does not exist until a note can be edited (ADR-0026). Once spacing is proven,
  the remaining engraver work is predictable enough to interleave or defer without risk.
- **Then the rest of parity, and Petaluma.** Mechanical by then, and V5's chord grammar
  will have arrived to make the chord-symbol typography worth doing properly rather than
  twice.

The alternative — all of parity before V2 — is defensible now that the estimate is real,
and it has one genuine advantage: V4's browser UI would be built against the final
renderer. It is not recommended only because it front-loads a week of glyph work whose
outcome nobody is uncertain about.
