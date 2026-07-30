# V1b: the engraver spike

The exit condition for [ADR-0030](adr/0030-own-the-engraver.md): engrave one system from
scratch off Bravura's own metrics, put it beside VexFlow's on the same layout, and come
back with a real estimate.

**Status: built, awaiting the gate decision.** What follows is the evidence and the
estimate. The four questions at the end are Jian's to answer.

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

## The seam gap this surfaced

Within-bar spacing **is** the adapter's job, by the division of labour the layout contract
itself states (`packages/layout/src/items.ts`, ADR-0014): layout hands over `bar.x` and
`bar.width`, and the adapter decides where in that box each onset goes. So the spacing code
is in the right package. `CLAUDE.md` had dropped "note spacing within the box" from its
summary of that split; the code is right and the doc has been corrected.

But **the prefix width is not published, and it has to be**. `layout/src/widths.ts`
already computes how wide the clef, key signature and time signature are — it sizes every
bar around them — and then keeps the number private. An adapter that wants to know where
a bar's music starts must therefore guess it a second time. VexFlow guesses from its own
glyph tables; the spike guesses from a copy of layout's own constants. That is why the two
engravings disagree on where a bar's first notehead sits, and it is the one contract
change this spike asks for. It is small: one number per `LayoutBar`.

## The estimate

Measured basis: the spike is **1,100 lines of engraver, 464 lines of test, 31 tests, one
day**, and it covers the metrics foundation plus the item ADR-0030 called the main risk.
The whole VexFlow adapter is 589 lines and covers all thirteen item kinds, so line counts
are not the unit — comment density here is high and the remaining work is not uniform.

In units of "one spike":

| Remaining work | Size | Notes |
|---|---|---|
| **Within-bar spacing engine** | 1.5–2 | Glyph-width aware, accidental allowance, minimum distances. The schedule risk, and the thing that decides whether the output looks professional |
| Chord symbols | 1 | Interlocks with V5's chord grammar (ADR-0012); needs text advance widths, since `measureText` is forbidden (ADR-0015) |
| Rests, clefs, key and time signatures, barlines, voltas, tuplet brackets and digits | 1.5 | Mechanical and data-driven: more glyphs, more `engravingDefaults`, no new problems |
| Ties and slurs | 0.5 | Bézier from `tieEndpointThickness` / `tieMidpointThickness`; half-ties across system breaks already exist in the contract |
| Title block, bar numbers, rehearsal marks | 0.25 | `text.ts`'s `text-anchor` approach carries over unchanged |
| Parity harness: census diff against the committed snapshots, switch the PDF path, retire the VexFlow adapter | 0.5 | The snapshots are the specification and already exist |
| **Total** | **5–6** | |

**So: 5–6 focused days to parity, and two calendar weeks at this project's pace.** That is
ADR-0030's "weeks rather than months", now with a basis under it. Two caveats on the
number, both stated rather than hidden:

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

## The gate: four questions

1. **Is the glyph-anchoring design approved?** Vendored Bravura slice, generated by a
   script from the pinned release, outlines placed by transform, every metric read from
   `engravingDefaults` and the glyphs' own anchors, no per-glyph tuning.
2. **Is the estimate accepted at 5–6 focused days / ~2 weeks**, with spacing named as the
   risk rather than beams?
3. **Does the contract grow a published prefix width?** One number per `LayoutBar`. It
   would let both adapters agree on where a bar's music starts.
4. **Which beam slant is right for this product** — Gould's conservative table, which is
   what the spike does, or VexFlow's steeper slant that follows the noteheads more
   closely? Bar 6 shows the difference plainly, and it is a house-style decision rather
   than a correctness one.

Answering 1 and 2 closes ADR-0030's exit condition and sets the position of the full
replacement in the slice order.
