# sibei-score — agent brief

A local-only jazz lead sheet notation app. Read this before touching anything.

**Trust the code over these docs.** Where they disagree, the code is right and this file is
stale — fix it.

## Build status, honestly

**V1 of 14 slices is done** (`SLICES.md`). What exists: the score model, the layout engine,
the VexFlow draw adapter, and the server-side PDF path. What does **not** exist yet: any
store, HTTP API, CLI, browser UI, chord grammar, transposition, MusicXML codec, or import
pipeline. Do not assume a module is there because a plan mentions it.

**The V1 gate has run and is closed.** The decision: **own the engraver** (ADR-0030). Not
because VexFlow's output was bad — it was good — but because jazz typography is this
product's differentiator, and 4.2.5 is the end of a line 5.x cannot continue server-side.

**V1b's gate has passed and V1c is done.** `packages/engrave` engraves noteheads, stems,
flags, ledger lines, beams, accidentals and dots from Bravura's own metrics, behind the
same seam as the VexFlow adapter, with real within-bar spacing and a font seam that lets a
face be chosen per render. `pnpm proof nasty-chart --bar 6 --compare` is the demo. The
gate outcome and the estimate are in `docs/v1b-engraver-spike.md`.

**V1d is what remains**: every glyph the contract can emit that the engraver does not draw
yet, plus Petaluma as the jazz face, then retiring the VexFlow adapter. Until then the
engraver is **not wired into the PDF path** — `pnpm render` still goes through VexFlow,
unchanged, and the committed snapshots are still VexFlow's.

## Commands

```sh
pnpm install               # pnpm workspace; --frozen-lockfile in CI
pnpm check                 # typecheck every package, then the suite. The gate.
pnpm typecheck             # each package under its own strict config
pnpm test                  # vitest, 147 tests
pnpm test:watch
pnpm render:nasty          # out/nasty-chart.pdf — the V1 demo
pnpm render all            # every fixture
pnpm vendor:bravura        # regenerate the vendored Bravura slice (needs network)
pnpm hooks:install         # point git at .githooks (do this once per clone)
```

## Proofing visual output — do this, it is not optional

Engraving defects are visual and the test suite does not catch them. 82 green tests and a
passing snapshot coexisted happily with every beamed note drawing a stray flag *and* a
doubled stem. Someone had to look. **After any change that touches `layout`, `draw` or
`pdf`, look at the result.**

```sh
pnpm proof                            # every fixture, whole pages
pnpm proof nasty-chart --systems      # every system as its own image
pnpm proof nasty-chart --bar 6        # one bar, zoom chosen for you
pnpm proof nasty-chart --system 2 --census
pnpm proof nasty-chart --pdf          # proof the PDF itself, if a rasteriser is present
pnpm proof nasty-chart --bar 6 --engraver   # our engraver instead of VexFlow
pnpm proof nasty-chart --bar 6 --compare    # both, stacked, same crop and same scale
pnpm proof nasty-chart --bar 6 --font normal  # pick the face; jazz lands with V1d
```

`--compare` is what the V1b gate looks at, and it earns its keep the same way `--census`
does: same `LayoutResult`, same crop, same zoom, so every difference in the image is a
difference in engraving. It found a stem pointing the wrong way on a note sitting on the
middle line that twelve green tests had no opinion about.

Crops are named after the music, not pixel coordinates: layout knows where every system
and bar sits, so `--bar 11` is exact and the zoom lands at a readable size on its own.
Each run prints a manifest of what it wrote and what each image shows, so **read those
files** — that is the point of the tool.

`--census` is the highest-value flag. It counts the SVG's elements and diffs them against
the committed snapshot:

```
vf-stem     73  58  -15        <- 15 beamed notes were drawing two stems each
<path>     344 314  -30        <- ...and a flag each on top of that
```

That table is what diagnosed the beaming bug, where the raw snapshot diff said only
"one very long line differs". Reach for it whenever a snapshot moves and you want to know
*what* moved before you accept it.

**Never refresh a snapshot to make a red test green.** Run `--census`, understand the
delta, look at the image, and only then accept it.

Proofing the PDF needs an external rasteriser. None is committed because ADR-0027 keeps
the dependency register permissive and the capable ones are mostly copyleft — a tool you
look at output with is a separate program, not part of the product, but it does not belong
in the lockfile either. Any one of these works, and `pnpm proof --pdf` finds it:

```sh
uv tool install --with pillow pypdfium2   # no root; PDFium, BSD/Apache
sudo apt install poppler-utils            # pdftoppm; GPL
sudo apt install mupdf-tools              # mutool; AGPL
```

With none installed, `--pdf` says so and carries on. Little is lost: the PDF is a
conversion of exactly the SVG geometry and an e2e test pins it to identical bytes, so the
SVG proof stands in for the engraving and only the conversion goes unseen.

The older single-file previewer is still there for ad-hoc use:

```sh
pnpm tsx scripts/preview.ts out/nasty-chart.page1.svg 2
pnpm tsx scripts/preview.ts out/nasty-chart.page1.svg 4 --crop 60,150,900,200
```

Refresh SVG snapshots **deliberately**, never to make a red test go green without reading
the diff first:

```sh
UPDATE_SNAPSHOTS=1 pnpm test
```

## The planning corpus is authoritative

This project was fully planned before any code. Those documents are decisions of record,
not background reading.

| File | Role |
|---|---|
| `PLAN.md` | Scope, requirements R0–R9, mechanisms P1–P21, testing approach, assumed defaults |
| `SLICES.md` | The 14 slices in build order, each with its own test plan |
| `CONTEXT.md` | Glossary and the 62-decision register. **Use these terms exactly.** |
| `docs/adr/` | 29 ADRs — the decisions themselves |
| `QUESTIONS.md` | The Q&A audit trail behind them |

Two rules follow. **Ask before deviating from any ADR.** And **if something in the plan
turns out to be wrong, say so rather than working around it** — a silent workaround
destroys the value of having planned.

## Hard invariants

Breaking one of these breaks a decision of record.

- `model`, `music`, `layout` and `codec` are plain TypeScript: **no framework, no Node
  APIs.** `layout` runs in the browser *and* server-side (ADR-0005, ADR-0022). Enforced by
  the compiler — those packages declare `"types": []` and no DOM lib — and by `tests/arch`.
- **The op applier is the only thing that writes to the store** (ADR-0003). *V2.*
- **MusicXML is a codec at the edges only**, never the runtime truth (ADR-0004).
- **`draw` never makes layout decisions; `layout` never mentions VexFlow** (ADR-0014).
- **Metrically invalid bars are stored and flagged, never rejected** (ADR-0013). Nothing in
  the pipeline may repair or refuse a bar.
- Every capability is an **op** with both a CLI verb and a UI control, or it is not built
  (Q79). Parity between the two surfaces is a constraint, not an aspiration.

## Layout

```
packages/
  model      score types, tick arithmetic, pitch, derived metric validity
  layout     score -> engine-independent positions: the four-bar grid
  draw       layout positions -> glyphs, via VexFlow (pinned to 4.2.5, see below)
  engrave    layout positions -> glyphs, ours, off Bravura's metrics. V1b spike
  pdf        server-side render: headless DOM -> SVG -> PDF, metadata pinned
  fixtures   hand-authored scores, including the nasty test chart
tests/
  unit/  integration/  e2e/  arch/     snapshots/   committed .svg files
scripts/     development entry points, not product surface
```

### The layout seam

`layout(score, pageSpec) -> pages -> systems -> bars -> items`.

Layout owns everything **above** the bar: which bars go on which line, where each bar box
sits and how wide it is, how tall a system needs to be, page breaks, the title block, and
which accidental each note draws. The adapter owns engraving **inside** a bar box: stem
direction, beam grouping, accidental stacking, tie curves, **and where in the box each
onset sits** — the contract says so in `packages/layout/src/items.ts`, and this file used to
leave that last one out.

If you find yourself computing a position *above* the bar in an adapter, it belongs in
`layout`. If you find yourself naming a glyph in `layout`, it belongs in the adapter.

Two adapters implement the seam now, and `tests/arch` holds both to it. `LayoutBar`
publishes `prefixWidth` — the room the clef, key and time signature were allocated — so
both agree on where a bar's *music* starts rather than each guessing.

### The engraver, and how Bravura gets in

`packages/engrave` is framework-free like `layout` and `model`: it emits SVG **markup**
rather than DOM nodes, so it needs no `document` and no jsdom. Keep it that way — a test
deletes `globalThis.document` and renders anyway.

Its metrics are vendored, not derived. `packages/engrave/src/fonts/*.generated.ts` is
generated by `pnpm vendor:bravura` from a pinned release and is **not edited by hand**:
glyph outlines plus `engravingDefaults`, cross-checked between the font's SMuFL metadata
and its own outlines. Licensing is in `packages/engrave/NOTICE.md` (SIL OFL 1.1).

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

### VexFlow is pinned to 4.2.5, and is on its way out

Do not upgrade to 5.x, and do not invest in it either. 4.x draws every music glyph as a
filled `<path>`; 5.x draws them as Bravura `<text>` measured through a canvas, which a
headless DOM does not have. That breaks server-side rendering outright and would make
byte-stable PDF output depend on font subsetting.

It stays in place behind the seam, unchanged, until our own engraver reaches parity
(ADR-0030). Fix bugs in the adapter, but do not extend it — new engraving work belongs in
`packages/engrave`. Reasoning in full: `docs/v1-render-gate.md`, then
`docs/v1b-engraver-spike.md`.

The committed SVG snapshots are the **specification** the new engraver has to meet, and
`pnpm proof --census` is how you read the difference. That is the whole reason this
replacement is affordable.

For the same reason, **do not use `ctx.measureText` or anything that reaches `getBBox()`**
in `draw`. Only a real browser implements it, so measuring would place text differently on
screen and in print, and ADR-0015 requires those cannot drift. Place text with SVG
`text-anchor` instead (`packages/draw/src/text.ts`).

## Workflow

`main` is protected: **PR-only, CI green before merge, no direct pushes.**

1. Branch per slice off a fresh `main`: `git fetch origin && git switch -c v2/one-write-path origin/main`
2. Build the slice. Match the surrounding style — comment density, naming, and the habit of
   citing the ADR that forced a decision.
3. Run `pnpm check` locally. The pre-push hook does this for you.
4. Open a PR saying what and why, with the test evidence.
5. Land on green.

Keep slices vertical and small, the way `SLICES.md` already cuts them. Do not start a slice
before the one it depends on, and do not do a later slice's work early — if you find you
need to, say so.

### Testing

Follow the test plan in `SLICES.md` for the slice you are on; it is written per slice and it
is specific.

- **Every layer is currently fast and needs no infra.** When V2 introduces SQLite, split the
  suite so the no-infra layer stays runnable on its own, and keep the pre-push hook on the
  fast layer only.
- **Every bug and every flake becomes a test first**, then gets fixed.
- The highest-value seam is the HTTP API, because both surfaces go through it (`PLAN.md`).
  Most behavioural tests belong there from V2 on.
- Snapshots catch unintended change. They do not judge whether the engraving looks *good* —
  only a person does that.

## Deliberately not built yet

Not oversights. Each lands with the slice that needs it.

| Gate | When | Why not now |
|---|---|---|
| Containerized test infra | V2 | Nothing needs a database yet |
| E2E that boots the stack | V4 | There is no stack to boot |
| Health endpoint, structured logs | V2 | There is no server |
| Deploy gating | never, as such | Local-only by decision (ADR-0001). V8 ships a container; there is no environment to deploy to |
| Published docs site | undecided | ADRs already carry the "why". Revisit if the CLI reference outgrows a README |
| Linter / formatter | undecided | `tsc` is strict and there is one author. Adding one now means reformatting the whole tree; ask first |
| Rests, clefs, key/time signatures, barlines, ties, chord symbols in the engraver | V1d | The gate passed and the estimate is real; V1d finishes the glyph set and retires `draw` (ADR-0030) |
| The jazz face | V1d | The seam is built and Bravura sits behind it. Petaluma needs a font parser at vendoring time, because it ships no SVG font |
