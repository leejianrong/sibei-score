# sibei-score — agent brief

A local-only jazz lead sheet notation app: single staff, chord symbols above it, four bars to a
line, editable from a browser or a CLI and exportable as a printable PDF.

**Trust the code over these docs.** Where they disagree, the code is right and this file is
stale — fix it, in the same PR that made it stale.

## Status

**V1–V4 are done; V5 (chords) is next.** `SLICES.md` is the plan of record and carries per-slice
history; `agent_docs/history.md` records how each slice was actually cut. What exists: the score
model, the layout engine, our own engraver, the server-side PDF path, the store, the op log and
applier, the `/v1/` API, the CLI with its text projection, export from the store, an SSE change
stream, and a browser that opens a chart, edits it, and repaints live when something else does.
Not built yet: the chord grammar, transposition, the MusicXML codec, and the whole import
pipeline. Don't assume a module exists because a plan mentions it.

## Layout

```
packages/
  model      score types, tick arithmetic, pitch, derived metric validity
  layout     score -> engine-independent positions: the four-bar grid
  engrave    layout positions -> glyphs, ours, off a SMuFL font's own metrics
  pdf        server-side render: SVG -> PDF, metadata pinned. No DOM
  api        the server side: store, op log + applier, /v1/ routes, export, the change bus.
             `@sibei/api` is the port; `@sibei/api/sqlite` is the adapter
  cli        the `sbscore` binary — an HTTP client of the API, never a second write path
  ui         the browser: Svelte 5 + Vite. Renders through layout + engrave, never @sibei/pdf
  fixtures   hand-authored scores: nasty-chart, every-glyph, long-form (spills to page 2), untitled
tests/
  unit/  integration/  e2e/  arch/     no infra: the `fast` layer
  store/  api/  cli/  browser/         need a real store, socket or browser: the `infra` layer
  snapshots/                           committed .svg files
scripts/     development entry points, not product surface
```

## Commands

```sh
pnpm install               # pnpm workspace; --frozen-lockfile in CI
pnpm check                 # typecheck every package, then both suite layers. The gate.
pnpm typecheck             # each package under its own strict config. `ui` goes via svelte-check
pnpm test                  # vitest, both layers
pnpm test:fast             # the no-infra layer — what the pre-push hook runs
pnpm test:infra            # the layer that needs a real store (and, for browser/, a real Chromium)
pnpm serve                 # run the local API on 127.0.0.1:4321
pnpm sbscore <verb>        # the CLI. `pnpm sbscore --help` lists every verb
pnpm ui                    # the browser, on Vite. strictPort — it refuses rather than sliding
pnpm demo                  # V2's demo end to end, closing on an export. A CI job
pnpm demo:v4               # V4's live-update demo: serve + browser, edit from the CLI, watch it repaint
pnpm render all            # render every fixture to out/
pnpm proof                 # look at the engraving — see agent_docs/proofing.md
pnpm vendor:fonts          # regenerate the vendored font slices (needs network)
pnpm hooks:install         # point git at .githooks (do this once per clone)
```

## Hard invariants

Breaking one of these breaks a decision of record. Ask before deviating from any ADR.

- `model`, `music`, `layout` and `codec` are plain TypeScript: **no framework, no Node APIs.**
  `layout` runs in the browser *and* server-side (ADR-0005, ADR-0022). Enforced by the compiler
  (`"types": []`, no DOM lib) and by `tests/arch`.
- **The op applier is the only thing that writes to the store** (ADR-0003). `ScoreWriter` is a
  separate interface only the applier may name; `tests/arch` fails if anything else does.
- **Nothing outside `packages/api/src/store/sqlite-*.ts` may know SQLite exists** (ADR-0006).
  `@sibei/api` exports the port only; the adapter is an opt-in subpath, `@sibei/api/sqlite`.
- **One render path, reached differently per surface.** `layout` + `engrave` is the only thing
  that turns a score into glyphs. The server goes through `@sibei/pdf`; the browser composes
  `layout()` + `engravePage()` itself and **may never import `@sibei/pdf`** (pdfkit + `Buffer` in
  the bundle); the CLI renders nothing and asks the API. An integration test asserts the browser's
  SVG is byte-identical to `renderScoreToSvg`'s across every fixture × paper × face (ADR-0014,
  ADR-0015).
- **MusicXML is a codec at the edges only**, never the runtime truth (ADR-0004).
- **The adapter never makes layout decisions; `layout` never names a renderer** (ADR-0014).
- **Metrically invalid bars are stored and flagged, never rejected** (ADR-0013). Nothing may
  repair or refuse a bar for its rhythm.
- **Never `measureText` or `getBBox()`** — they exist only in a real browser and would drift
  screen from print (ADR-0015). Place text with SVG `text-anchor`. See `agent_docs/architecture.md`.
- Every capability is an **op** with both a CLI verb and a UI control, or it is not built (Q79).
  The one remaining knowing exception: `score.create` and `meta.set` have a CLI verb and no UI
  control yet.
- **The two surfaces must not disagree about a user-facing *string* either.** The browser's
  `CLI_BINARY` is asserted equal to the `bin` key in `packages/cli/package.json`. If two in-flight
  cards share a string rather than a file, one of them owes a guard.

## Proofing — not optional

Engraving defects are visual and the tests do not catch them. **After any change to `layout`,
`engrave` or `pdf`, look at the output** with `pnpm proof` (and `--census` when a snapshot moves).
Full guide: `agent_docs/proofing.md`. Never refresh a snapshot to make a red test green.

## Workflow

`main` is protected: **PR-only, CI green before merge, no direct pushes.** Branch per slice off a
fresh `main`. Match the surrounding style — comment density, naming, and citing the ADR that forced
a decision. Run `pnpm check` locally (the pre-push hook runs the `fast` half).

**The six required status checks are matched by name, and the names are load-bearing** — a CI job's
`name:` must keep matching its context string or the check can never report and the PR can never
merge:

```
typecheck    test    test (infra)    render the fixtures    secret scan    the V2 demo
```

Renaming a CI job is a two-part change (workflow + branch protection, together, in one operation);
getting the order wrong made every PR unmergeable once. `the V2 demo` is misnamed on purpose — it
covers V3's export demo too — and correcting it is not worth the window in which nothing can merge.

Protection is also **strict** ("require branches up to date"), which serialises landings: when one
PR merges, every other open PR goes `BEHIND` and is refused even while green. Update the branch,
wait for the re-green, then merge. Parallelise implementation; never parallelise landing.

## The planning corpus is authoritative

Fully planned before any code — decisions of record, not background reading.

| File | Role |
|---|---|
| `PLAN.md` | Scope, requirements R0–R9, mechanisms P1–P21, testing approach, assumed defaults |
| `SLICES.md` | The 14 planned slices in build order, each with its own test plan |
| `CONTEXT.md` | Glossary and the decision register. **Use these terms exactly.** |
| `docs/adr/` | The ADRs — the decisions themselves |
| `QUESTIONS.md` | The Q&A audit trail behind them |

If something in the plan turns out to be wrong, **say so rather than working around it** — a silent
workaround destroys the value of having planned.

## Deeper references

Loaded when the task reaches them; the root file stays a table of contents.

| File | When to read it |
|---|---|
| `agent_docs/architecture.md` | Touching `layout`, `engrave`, addressing, or hit-testing |
| `agent_docs/server.md` | Touching the store, the op log, export, the `/v1/` API, or the change stream |
| `agent_docs/surfaces.md` | Touching the CLI, the text projection, or the browser |
| `agent_docs/proofing.md` | Looking at engraving output (do this after any render change) |
| `agent_docs/testing.md` | Writing tests, or deciding which suite layer a directory joins |
| `agent_docs/history.md` | The per-slice build history and the "not built yet" roadmap |

MIT licensed — see `LICENSE`.
