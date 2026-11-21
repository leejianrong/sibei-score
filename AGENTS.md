# sibei-score — agent brief

A jazz lead sheet notation app: single staff, chord symbols above it, four bars to a line, editable from
a browser or a CLI (and, hosted, from an MCP client), exportable as a printable PDF, MusicXML or SVG. It
runs **local-only by default** (owner `local`, no sign-in, offline) and as a **hosted web app** when
configured (ADR-0034). Import turns a photo/scan (OMR worker) or an audio transcription (NoteEvents) into
an editable draft.

**Trust the code over these docs.** Where they disagree, the code is right and this file is stale — fix
it, in the same PR that made it stale.

## Status

Dated 2026-11-22. v0.1 (editor), v0.2 (photo import) and v0.3 (the bespoke recogniser, default engine
still `oemer` pending V17f) are built; **v0.4 (hosted, ADR-0034) is built but not deployed** — GitHub login,
Postgres + Redis, API tokens (`sbscore auth`), a remote MCP endpoint (`/mcp`, `sbscore mcp`), audio jobs
and the hosted Compose stack (`compose.hosted.yaml`, `docs/deploy-hosted.md`). Hosted mode is selected by
configuration only (`--public-url`, `--github-client-id`, `SBSCORE_GITHUB_CLIENT_SECRET`: all or none); it
refuses photo import unless `SBSCORE_PHOTO_IMPORT=on`. The current work (epic SIB2-E12, ADR-0039) is
closing the notation gaps found against real lead-sheet pages — tuplets, slurs, fermatas, articulations,
ottava, tempo, text directions, page furniture, chord styles and bar add/remove are in; see
`docs/gap-inventory.md` for what remains (navigation marks, extra title fields, grace notes, and the
multi-staff model, which is a *proposed* design only: ADR-0041). Don't assume a module exists because a
plan mentions it.

History lives elsewhere: `SLICES.md` (the plan, per-slice notes), `agent_docs/history.md` (how each slice
was cut, plus the full pre-trim status log), and the ADRs. Per-area detail is in `agent_docs/` (below).

## Layout

```
packages/
  model      score types, tick arithmetic, pitch, derived metric validity, spelling, the OMR/NoteEvents
             mappers (omr-map.ts, note-events-map.ts). No framework, no Node
  music      the chord grammar: parse/format chord symbols to structure, the OCR corrector, parts
  codec      MusicXML at the edges (ADR-0004): score <-> MusicXML string, single-voice. Own XML reader
  layout     score -> engine-independent positions: the bar grid, page furniture
  engrave    layout positions -> glyphs, ours, off a SMuFL font's own metrics
  pdf        server-side render: SVG -> PDF, metadata pinned. No DOM
  api        the server: store, op log + applier, /v1/ routes, export, change bus, auth, import and audio
             jobs, limits, /mcp. `@sibei/api` is the port; the adapters are opt-in subpaths
             `@sibei/api/{sqlite,postgres,redis}`
  cli        the `sbscore` binary — an HTTP client of the API, never a second write path
  ui         the browser: Svelte 5 + Vite. Renders through layout + engrave, never @sibei/pdf.
             Account chrome uses Material 3 tokens only (`src/m3.css`): generate a set from a seed,
             never hand-edit a role
  fixtures   hand-authored scores (nasty-chart, every-glyph, long-form, untitled, aaba-chart, ...)
  synth      DEV-ONLY: synthetic corpus + OMR eval metrics. May use Node APIs (ADR-0031 exception), never
             in a product bundle. `@sibei/synth/imaging` is the native (resvg+sharp) half
worker/      the OMR worker (Python, ADR-0005) — OUTSIDE the pnpm workspace, own pyproject/venv. An HTTP
             recogniser (`sibei_omr/server.py`) over engines `sibei_omr/engines/{oemer,heuristic,bespoke}`
             (`--engine`/`$SIBEI_OMR_ENGINE`, default oemer; heuristic is OpenCV-only dev scaffolding,
             bespoke is the trained staged recogniser) + PaddleOCR chord-band OCR (ADR-0027). Weights
             are baked and checksummed at build (ADR-0024). Stateless, never touches the store, own
             `unittest`s, not in Node CI. `devtools/{omr_viz,label_studio}` are dev-only viewers /
             the labelling studio (ADR-0036): never shipped, never in CI. See `worker/README.md`
tools/runpod/ DEV/BUILD-TIME ONLY (ADR-0032): a guardrail wrapper (`rp`) that runs the worker container
             on a rented RunPod pod and guarantees teardown. OUTSIDE the pnpm workspace, imports no
             `packages/*`. The `RUNPOD_API_KEY` lives only in the gitignored `tools/runpod/.env` and `rp`
             reads it BY REFERENCE. **Never read `tools/runpod/.env` (or the key value) into context, and
             never cat/echo/print/log it** — handle it blind, machine-to-machine only (ADR-0032)
tests/
  unit/  integration/  e2e/  arch/     no infra: the `fast` layer
  store/  api/  cli/  browser/         need a real store, socket or browser: the `infra` layer
  imaging/  eval/                       native resvg+sharp / the eval harness — also `infra`
  postgres/  redis/  s3/               opt-in: run only against a real Postgres / Redis / S3 gateway
  snapshots/                           committed .svg files
  fixtures/                            committed inputs (migration, omr/, note-events/, eval/real/)
deploy/  compose.yaml  compose.hosted.yaml  Dockerfile    the local container and the hosted stack
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
pnpm test:postgres         # the Postgres adapter on a throwaway Postgres (Docker, or SBSCORE_TEST_DATABASE_URL)
pnpm test:redis            # the Redis bus and limits (opt-in; CI runs it in the `test (postgres)` job)
pnpm test:s3               # the shared blob contract against a throwaway S3 gateway (opt-in)
pnpm serve                 # run the local API on 127.0.0.1:4321
pnpm sbscore <verb>        # the CLI. `pnpm sbscore --help` lists every verb; docs/cli.md is the reference
pnpm ui                    # the browser, on Vite. strictPort — it refuses rather than sliding
pnpm demo                  # V2's demo end to end, closing on an export. A CI job
pnpm demo:v4               # V4's live-update demo: serve + browser, edit from the CLI, watch it repaint
pnpm render all            # render every fixture to out/
pnpm eval                  # score OMR accuracy (needs the worker; --engine fixture to smoke). docs/eval.md
pnpm proof                 # look at the engraving — see agent_docs/proofing.md
pnpm vendor:fonts          # regenerate the vendored font slices (needs network)
pnpm hooks:install         # point git at .githooks (do this once per clone)
bash scripts/smoke-hosted.sh   # the whole hosted stack on loopback with a fake GitHub (not a CI job)
```

## Server and hosted-mode rules that bite

- A new `/v1/` route is **private in hosted mode** until `isPublic` in `packages/api/src/http/server.ts` opens
  it. A request that names a bearer token is judged by it alone; approval and token management take a
  cookie, never a token; `mcp:*` scopes reach `/mcp` only and `read`/`write` reach `/v1/` only.
- Account deletion (`DELETE /v1/auth/account`) has no CLI verb on purpose. A new table with an
  `owner`/`user_id` column must be covered by erasure (`tests/arch/account-erasure-coverage.test.ts`).
- A new server error kind needs an exit-code decision in `packages/cli/src/exit-codes.ts`
  (`tests/arch/exit-code-kinds.test.ts`).
- The audio worker PULLS work with an `sbsw_` credential (`SBSCORE_AUDIO_WORKER_TOKENS`) and can reach no
  user data. Persistence ports are async; `tests/arch/*` holds the boundaries (`http-boundary`,
  `mcp-boundary`, `async-ports`, `store-seam`).
- Import has two ways in, both landing through the server-only `Applier.import` (ADR-0003/0008): photo/scan
  OMR (worker, `imports/runner.ts`) and NoteEvents JSON (`imports/note-events.ts`, ADR-0040, no worker).
  Details: `agent_docs/server.md`.

## Hard invariants

Breaking one of these breaks a decision of record. Ask before deviating from any ADR.

- `model`, `music`, `layout` and `codec` are plain TypeScript: **no framework, no Node APIs.**
  `layout` runs in the browser *and* server-side (ADR-0005, ADR-0022). Enforced by the compiler
  (`"types": []`, no DOM lib) and by `tests/arch`. **`packages/synth` is the one sanctioned exception**
  (ADR-0031): a build-time data/eval tool that may use Node APIs, and in return `tests/arch` forbids any
  product-runtime package (`pdf`/`api`/`cli`/`ui`) from importing it — it must never enter a bundle.
- **The op applier is the only thing that writes to the store** (ADR-0003). `ScoreWriter` is a
  separate interface only the applier may name; `tests/arch` fails if anything else does.
- **Nothing outside `packages/api/src/store/sqlite-*.ts` may know SQLite exists, and nothing outside
  `postgres-*.ts` may know Postgres exists** (ADR-0006, ADR-0034) — per driver, so neither adapter depends on
  the other's. `@sibei/api` exports the port only; the adapters are opt-in subpaths, `@sibei/api/sqlite` and
  `@sibei/api/postgres`. Every persistence port is async (V18), and both adapters answer to one contract
  (`tests/store/conformance.ts`).
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
  The one remaining knowing exception: `score.create` has a CLI verb and no UI
  control yet (`meta.set` has had its title block in the rail since SIB2-178, with the footer, chord style, bars per line and signature policy). (V8e gave `export --musicxml` its rail toggle, so export format now has both.) (V6's `transpose`, part export and `--spell` pins, and V7c's structure panel —
  section, barlines and endings, reached by clicking a bar — each have a control in the score view.)
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

**The board follows the code, not the other way round.** File the card on pandan **board 13**
(sibei-score) *before* you start a slice, with points and acceptance criteria — V18, V19a and V19
merged on 2026-09-30 with no card, and three of this project's cards had been filed on another
project's board. At each sprint ceremony `git fetch` first and compare the merged `Vxx` PR titles on
`origin/main` against the cards; a checkout can be months behind (this one was), and `origin/main` is
the truth about what shipped.

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
| `SLICES.md` | The planned slices in build order (v0.1 to v0.5, V1 onward), each with its own test plan |
| `CONTEXT.md` | Glossary and the decision register. **Use these terms exactly.** |
| `docs/adr/` | The ADRs — the decisions themselves. Recent: 0034 hosted app, 0036/0037 real corpus and song ID, 0038 full notation as direction, **0039 product direction and schedule**, **0040 NoteEvents import**, **0041 parts x staves x voices (proposed)** |
| `QUESTIONS.md` | The Q&A audit trail behind them |

If something in the plan turns out to be wrong, **say so rather than working around it** — a silent
workaround destroys the value of having planned.

## Deeper references

Loaded when the task reaches them; the root file stays a table of contents.

| File | When to read it |
|---|---|
| `agent_docs/architecture.md` | Touching `layout`, `engrave`, addressing, or hit-testing |
| `agent_docs/server.md` | Touching the store, the op log, export, the `/v1/` API, auth, limits, import/audio jobs, or the change stream |
| `agent_docs/surfaces.md` | Touching the CLI, the text projection, or the browser |
| `agent_docs/proofing.md` | Looking at engraving output (do this after any render change) |
| `agent_docs/testing.md` | Writing tests, or deciding which suite layer a directory joins |
| `agent_docs/history.md` | The per-slice build history, the "not built yet" roadmap and the pre-trim status log |
| `agent_docs/v15-training-notes.md` | The bespoke-training retrospective (read before any training/RunPod work) |
| `docs/gap-inventory.md` | The real lead-sheet pages against the editor: which notation features are closed, which remain (ADR-0039) |
| `docs/omr-pipeline.md` | The staged OMR pipeline end to end, the engine seam, what's built vs deferred |
| `docs/eval.md` | The OMR evaluation harness: metrics, the accuracy + speed + RAM gate, how to run it |
| `docs/cli.md` | The user-facing `sbscore` CLI reference. `sbscore --help` is the live source of truth |
| `docs/hosting.md` | The hosted direction: target architecture, local-to-hosted seam map (a direction doc) |
| `docs/deploy-hosted.md` | The runbook for the hosted Compose stack: env, Caddy/TLS, backups, photo-import switch |

MIT licensed — see `LICENSE`.
