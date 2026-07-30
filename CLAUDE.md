# sibei-score — agent brief

A local-only jazz lead sheet notation app. Read this before touching anything.

**Trust the code over these docs.** Where they disagree, the code is right and this file is
stale — fix it.

## Build status, honestly

**V1 of 14 slices is done** (`SLICES.md`). What exists: the score model, the layout engine,
the VexFlow draw adapter, and the server-side PDF path. What does **not** exist yet: any
store, HTTP API, CLI, browser UI, chord grammar, transposition, MusicXML codec, or import
pipeline. Do not assume a module is there because a plan mentions it.

V1 ends in a decision that is Jian's alone: whether VexFlow's engraving is good enough or
we own the engraver (ADR-0014). See `docs/v1-render-gate.md`. **Nothing proceeds past that
gate without him.**

## Commands

```sh
pnpm install               # pnpm workspace; --frozen-lockfile in CI
pnpm check                 # typecheck every package, then the suite. The gate.
pnpm typecheck             # each package under its own strict config
pnpm test                  # vitest, 79 tests
pnpm test:watch
pnpm render:nasty          # out/nasty-chart.pdf — the V1 demo
pnpm render all            # every fixture
pnpm hooks:install         # point git at .githooks (do this once per clone)
```

Look at a rendered page without a PDF viewer:

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
direction, beam grouping, accidental stacking, tie curves.

If you find yourself computing a position in `draw`, it belongs in `layout`. If you find
yourself naming a glyph in `layout`, it belongs in `draw`.

### VexFlow is pinned to 4.2.5 on purpose

Do not upgrade to 5.x. 4.x draws every music glyph as a filled `<path>`; 5.x draws them as
Bravura `<text>` measured through a canvas, which a headless DOM does not have. That breaks
server-side rendering outright and would make byte-stable PDF output depend on font
subsetting. Reasoning in full: `docs/v1-render-gate.md`.

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
