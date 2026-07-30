# sibei-score

A local-only jazz lead sheet notation app. Single staff, chord symbols above it, four
bars to a line, printable from a music stand — reachable equally from a browser and a
CLI (`PLAN.md`).

Status: **V1 of 14** (`SLICES.md`). The render path exists; there is no store, no API,
no CLI and no UI yet.

## Reading order

| File | What it is |
|---|---|
| `PLAN.md` | Scope, requirements, mechanisms, testing approach, assumed defaults |
| `SLICES.md` | The 14 build slices in order |
| `CONTEXT.md` | Glossary and the 62-decision register — these terms are used exactly |
| `docs/adr/` | 29 ADRs, the decisions themselves |
| `QUESTIONS.md` | The question-and-answer audit trail behind them |

## Layout

```
packages/
  model      score types, tick arithmetic, pitch, derived metric validity
  layout     score -> engine-independent positions: the four-bar grid
  draw       layout positions -> glyphs, via VexFlow
  pdf        server-side render: headless DOM -> SVG -> PDF, metadata pinned
  fixtures   hand-authored scores, including the nasty test chart
tests/
  unit  integration  e2e  arch      snapshots/  committed SVG
scripts/     development entry points, not product surface
```

`model` and `layout` are plain TypeScript with no framework and no Node APIs, because
they run in the browser as well as on the server (ADR-0005, ADR-0022). That is enforced
by the compiler — those packages declare `"types": []` and no DOM lib — and by
`tests/arch`, which also checks the import graph and the declared dependencies.

## Commands

```sh
pnpm install
pnpm hooks:install      # once per clone: points git at .githooks
pnpm check              # typecheck every package, then the whole suite
pnpm test               # vitest
pnpm typecheck          # each package under its own strict config
pnpm render:nasty       # out/nasty-chart.pdf and its SVG pages
pnpm render all         # every fixture
pnpm render nasty-chart --paper letter
```

To look at a rendered page without a PDF viewer:

```sh
pnpm tsx scripts/preview.ts out/nasty-chart.page1.svg 2
pnpm tsx scripts/preview.ts out/nasty-chart.page1.svg 4 --crop 60,150,900,200
```

Snapshots are real `.svg` files under `tests/snapshots`, so a failing diff can be opened
in a browser. Refresh them deliberately:

```sh
UPDATE_SNAPSHOTS=1 pnpm test
```

## Gates

`main` is protected: PR-only, CI green before merge, no direct pushes.

| Where | What runs |
|---|---|
| Pre-push hook | `pnpm typecheck` and `pnpm test` — the cheap checks, so a push rarely lands red |
| CI, per PR | the same two as parallel jobs, plus rendering every fixture and a secret scan |

CI uploads the rendered PDFs as a build artifact, so a change to the engraving can be
looked at on the pull request rather than taken on trust. `git push --no-verify` skips the
local hook for a scoped push; CI is still the backstop. Contributor conventions and the
invariants an agent must not break are in `CLAUDE.md`.

## Invariants

These are decisions of record, not preferences. Breaking one means revisiting an ADR.

- `model`, `music`, `layout` and `codec` are plain TypeScript: no framework, no Node
  APIs. `layout` runs in the browser **and** server-side (ADR-0005, ADR-0022).
- The op applier is the only thing that writes to the store (ADR-0003). *V2.*
- MusicXML is a codec at the edges, never the runtime truth (ADR-0004).
- `draw` never makes layout decisions; `layout` never mentions VexFlow (ADR-0014).
- Metrically invalid bars are stored and flagged, never rejected (ADR-0013).

## The layout seam

`layout(score, pageSpec) -> pages -> systems -> bars -> items`.

Layout owns everything above the bar: which bars go on which line, where each bar box
sits and how wide it is, how tall a system needs to be, page breaks, the title block,
and which accidental each note draws. The draw adapter owns engraving inside a bar box:
stem direction, beam grouping, accidental stacking, tie curves. That split is what makes
the renderer replaceable, and `tests/integration/glyph-coverage.test.ts` asserts the
adapter handles every item kind the contract can emit.
