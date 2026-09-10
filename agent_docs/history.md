# Build history and the roadmap

The short status is in `AGENTS.md`; `SLICES.md` is the plan of record. This file keeps the
per-slice history — how each slice was actually cut, and what each cut taught — and the table of
things deliberately not built yet.

## How the slices were actually cut

**V4 is done** — the browser. It is the first slice with a UI at all, and the first that
can break "the two surfaces cannot disagree" by building a second way to do something. It was cut
into four sub-cards (KAN-587–590 under KAN-412), and the cut is *not* SLICES.md's six steps:
step 5 (SSE) turned out to be the one genuinely separable piece and went first, in parallel with
the shell, while steps 1–4 are a vertical chain that resists parallelising.

| | Delivers | State |
|---|---|---|
| V4a | `GET /v1/scores/:id/events`, the change bus | **done** |
| V4b | The Svelte 5 shell, the library view, the score view — read-only | **done** |
| V4c | Hit-testing, the inspector, and edits as ops | **done** |
| V4d | SSE wired to the browser, the stack E2E, and V4's demo | **done** |

**Q79 parity is met again as of V4c.** V4b shipped read-only on purpose — `score.create`,
`meta.set`, `note.*` and `rest.*` had a CLI verb and no UI control — and that was booked debt, not
an oversight: the UI's first write was V4c's whole subject, and splitting the first write across two
cards would have been worse than a slice of debt. V4c closed the note/rest edits; `score.create` and
`meta.set` still have no UI control and are the same knowing debt one card smaller, waiting on the
slice that gives the browser a "new chart" and a metadata editor.

**V4b is also where the design-first rule proved itself.** A UI card runs in two phases with the
same agent — a self-contained HTML mockup published for approval, *then* implementation with real
screenshots checked against it. Neither phase invented the other's job, and all seven mocked
states matched. Do it that way.

**V3 delivered R0, the first end-to-end path**, and it was cut into four sub-cards
(KAN-506–509 under KAN-411). Half of what SLICES.md lists for V3 turned out to be **already
built at V1** — page setup, the metadata header, the snapshot tests — which is why the cards
below are not the build plan's six steps:

| | Delivers | State |
|---|---|---|
| V3a | The `BlobStore` port, `GET …/export?format=pdf`, the on-demand cache | **done** |
| V3b | Pagination proven across a real page break, and the Q37 amendment | **done** |
| V3c | The planning-corpus staleness sweep — VexFlow and `packages/draw` | **done** |
| V3d | `sbscore export --pdf`, and `serve` wiring the directory blob store | **done** |

**V3b is why the proofing section is not decoration.** It found three defects by looking
at images, none of which any test had an opinion about — a rehearsal mark drawn in the paper
margin, a tie drawn through the key signature **at bar 9 of the nasty chart, wrong since V1**,
and a proof tool that cropped page 2's rectangle out of page 1's markup and produced a
convincing image of the wrong thing.

**V2 was built in five sub-slices**, the way V1 was cut into V1b–V1d and V3 into V3a–V3d,
because one write path is nine build steps and 13 points. Board cards KAN-468 through KAN-472,
under the KAN-410 umbrella:

| | Delivers | State |
|---|---|---|
| V2a | The store, migrations on read, and the suite split | **done** |
| V2b | The address resolver — `bar12.beat3`, `bar12.n3`, `note-17` | **done** |
| V2c | The op log, and the applier as the only writer | **done** |
| V2d | The `/v1/` API, the auth seam, and the Origin check | **done** |
| V2e | The CLI, and the text projection — carries V2's demo | **done** |

Nothing in V2 touched the renderer, so `pnpm proof` was not relevant to any of it — the
committed SVG snapshots never moved. V3b moved them for the first time since V1d, and
`--census` reported every fixture **structurally identical**: no element added or removed,
positions only.

**VexFlow is gone.** The V1 gate judged its output good and went the other way anyway,
because jazz typography is this product's differentiator rather than its polish and 4.2.5
was the end of a line 5.x cannot continue server-side (ADR-0030). `packages/engrave` now
draws every glyph the layout contract can emit, in either of two faces, and
`packages/draw` and the `vexflow` dependency have been removed. The reasoning is
`docs/v1-render-gate.md` then `docs/v1b-engraver-spike.md`; the outcome is on ADR-0030.

## Deliberately not built yet

Not oversights. Each lands with the slice that needs it.

| Gate | When | Why not now |
|---|---|---|
| Containerized test infra | probably never | V2a's answer turned out to be that SQLite needs no container: the `infra` layer runs against `:memory:` and temp files. Revisit only if something arrives that genuinely needs a daemon |
| A cap on concurrent event streams | when something needs one | A hostile page can hold streams open — it reads nothing (no CORS headers, so the browser refuses the page the bytes) but nothing limits the count. Resource exhaustion is outside ADR-0029's threat model, and the alternative fix (widening the Origin rule to cover GETs) would change an ADR's shape to buy it (KAN-601) |
| Replay on the event stream | when undo needs it | No `id:` is emitted, so no `Last-Event-ID` is promised. Replay needs a read surface over the op log and KAN-510 has deliberately not decided its shape — the first frame carrying the current version makes replay unnecessary for correctness |
| Anything serving the built browser | V4d or V8 | `pnpm ui:build` produces a bundle with no home. The dev server proxies `/v1/` to keep the UI same-origin, which is what ADR-0029's guards require; `sbscore serve` has no static path yet and inventing one was out of V4b's scope |
| A cache-hit signal on the export response | when something needs one | `Artefact.cached` exists internally; no header carries it, so the CLI cannot report it. `/v1/` goes additive-only after the hosted transition, so the shape is worth deciding rather than defaulting (KAN-528) |
| Eviction of cached artefacts | V8 | Superseded blobs accumulate. Correct by design — no `delete` on the port means nowhere to write invalidation logic — and eviction belongs with library lifecycle, where deleting a score should drop its blobs too (KAN-516) |
| Health endpoint, structured logs | **done, V2d** | `GET /v1/health`, and JSON-per-line on stderr |
| Deploy gating | never, as such | Local-only by decision (ADR-0001). V8 ships a container; there is no environment to deploy to |
| Published docs site | undecided | ADRs already carry the "why". Revisit if the CLI reference outgrows a README |
| Linter / formatter | undecided | `tsc` is strict and there is one author. Adding one now means reformatting the whole tree; ask first |
| Jazz chord-symbol typography — `Δ`, `ø`, stacked alterations | V5 | The engraver superscripts a chord's extensions, which is parity. Being *better* needs the chord grammar (ADR-0012) |
| Beams across rests, cross-beat groups | when a fixture needs one | Nothing in the corpus beams across a rest, and inventing the case would mean inventing the convention too |
