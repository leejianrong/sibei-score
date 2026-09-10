# Build history and the roadmap

The short status is in `AGENTS.md`; `SLICES.md` is the plan of record. This file keeps the
per-slice history — how each slice was actually cut, and what each cut taught — and the table of
things deliberately not built yet.

## How the slices were actually cut

**V8 is undo, MusicXML, the library, the container and the docs, cut into vertical sub-slices the
way V2–V7 were.** The verification pass paid off the way V7's did: the read surface over the op log
(`ScoreReader.operations`) and the library `delete` already existed, the `batch` column has grouped
undoable units since V2c, and migration-on-read has been real since V6d — so undo owed no schema
change and no new store method.

| | Delivers | State |
|---|---|---|
| V8a | Undo/redo by replay of the op log — control ops, `POST …/undo\|redo`, `sbscore undo\|redo`, ctrl-Z | **done** |
| V8b | The `codec` package: MusicXML export + import, single-voice, every lossy case named | planned |
| V8c | Library delete + duplicate (design-first UI) | planned |
| V8d | A migration fixture through every schema version | planned |
| V8e | The container: Dockerfile + compose + a persistent volume, networking-disabled-except-port | planned |
| V8f | v0.1 docs: install, the CLI reference, the offline claim | planned |

**V8a's one real decision was how undo persists, and the append-only log forced it.** ADR-0003 keeps
the log append-only forever — `sqlite-store.ts` has no UPDATE or DELETE against it, and
`one-writer.test.ts` fails if one appears — because rewriting history is exactly what undo-by-replay
must never do. So undo cannot delete the last batch's rows, and it cannot overwrite the document
either, because `replay(log) == stored doc` is a tested property. It appends an `undo` **control
operation** instead: a `LoggedOperation` that is not a content verb (it can't be folded from the
score alone — its result needs the whole log). `replayLog` resolves the markers against the log
(`resolveLog` walks batch order into an applied stack and a redo stack) and folds the survivors, so
the append-only log still reproduces the document exactly, undo included — the ADR-0003 property
test extends to become undo's correctness proof. No inverse operations (the thing ADR-0003 rejected)
and no schema change: the existing `type`/`payload`/`batch` columns carry a control op, which is its
own batch of one. This is the KAN-510 shape decision, made at the point of use rather than up front.
A batch undoes as one unit because it *is* one unit in the log; undo at the `score.create` floor and
redo past the head are `moved: false` no-ops, not errors.

**V7 is structure and page, and most of it turned out to be already built at V1.** SLICES.md's
build plan reads as if the glyphs and the line-breaking were V7's to write; the code says
otherwise. The model shapes (`Section`, `Bar.startBarline|endBarline|ending`) landed at V1 per
ADR-0026, so no migration is owed. `layout` already breaks the four-bar grid at real
`score.sections` (`planSystems` via `startsSection`) and already emits the `rehearsalMark`,
`barline`, `endBarline` and `ending` items; `engrave` already draws every one of them, wired into
`engrave.ts` and proven by the committed snapshots. So V7 is the **write path** — the ops that set
these fields — plus the CLI and UI to drive them, and proofing that user-set structure renders. It
is *not* a rendering slice. The cut:

| | Delivers | State |
|---|---|---|
| V7a | `section.set|rm` ops, the `bar12` whole-bar address, `sbscore section set|rm`, layout wiring verified | **done** |
| V7b | `barline.set` + `ending.set|rm` ops, `sbscore barline/repeat/ending`, the AABA demo fixture, proofed | **done** |
| V7c | The browser Structure panel — click a bar, edit its section/barlines/ending (design-first) | **done** |

**V7b proved the last of the structure rendering by adding the fixture that exercises it.** The
engraver already drew every barline kind and every ending *role*, but the corpus only ever set a
one-bar `start-stop` ending (`every-glyph`), so a **multi-bar** ending — `start` … `stop` across two
bars — and a **2nd** ending had never been rendered. The `aaba-chart` fixture is the demo *and* the
missing proof: a pickup, four rehearsal-lettered sections, and a repeat around the first A with a
1st ending closed by a `repeat-end` and a 2nd ending on the next bar. `pnpm proof aaba-chart --system 2`
shows the two brackets landing on the right bars with their hooks and numbers; the committed
`aaba-chart.page1.svg` snapshot pins it. `repeat set` is CLI sugar — a `repeat-start`/`repeat-end`
pair of `barline.set`s in one batch — so the op set stays minimal (`barline.set`, `ending.set`,
`ending.rm`).

**V7c closed the Q79 debt V7a/V7b booked, design-first.** A mockup built around the real
`aaba-chart` render was published and approved before a line of the panel was written; the
implementation was then checked against it with real screenshots (`pnpm screenshots` grew a
`structure-panel.png`), and the one thing the shot caught — a four/five-way word-labelled segmented
control overflowing the 292px rail — became a `fill` variant on `SegmentedControl` rather than a
one-off. **Selecting a bar** extends the hit-test the way V4c/V5e extended it for notes and chords:
`bar-hit.ts` boxes each bar's staff region (a barline sits on a bar edge, so clicking one selects
the bar it bounds), and clicking bare staff selects the bar where it used to deselect. The panel's
Save turns the diff against the bar's current structure into the minimal batch of V7a/V7b's ops
(`structure-edits.ts`, a pure function unit-tested in the fast layer); a browser test drives the
whole click→edit→save→store→engrave round trip.

**V7a added a fourth address form, `bar12` — a whole bar.** Structure attaches to a bar rather than
to a beat within one, so `resolveBar` is its resolver, kept separate from `resolveAddress` (which is
about the notes and chords *inside* a bar). A rehearsal letter therefore keys on a **bar number**
and survives notes being inserted before it, which is the V7 unit case. `section.set` is an upsert
like `chord.set`: the same verb creates a section and later edits its letter or name.

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
| Replay on the event stream | still not needed | No `id:` is emitted, so no `Last-Event-ID` is promised, and the first frame carrying the current version makes stream replay unnecessary for correctness. V8a's undo did not want it: undo reads the op log server-side (`ScoreReader.operations`, the read surface KAN-510 left open and V8a settled) and publishes a plain `changed` event like any edit — the client re-reads, exactly as it already did |
| Anything serving the built browser | V4d or V8 | `pnpm ui:build` produces a bundle with no home. The dev server proxies `/v1/` to keep the UI same-origin, which is what ADR-0029's guards require; `sbscore serve` has no static path yet and inventing one was out of V4b's scope |
| A cache-hit signal on the export response | when something needs one | `Artefact.cached` exists internally; no header carries it, so the CLI cannot report it. `/v1/` goes additive-only after the hosted transition, so the shape is worth deciding rather than defaulting (KAN-528) |
| Eviction of cached artefacts | V8 | Superseded blobs accumulate. Correct by design — no `delete` on the port means nowhere to write invalidation logic — and eviction belongs with library lifecycle, where deleting a score should drop its blobs too (KAN-516) |
| Health endpoint, structured logs | **done, V2d** | `GET /v1/health`, and JSON-per-line on stderr |
| Deploy gating | never, as such | Local-only by decision (ADR-0001). V8 ships a container; there is no environment to deploy to |
| Published docs site | undecided | ADRs already carry the "why". Revisit if the CLI reference outgrows a README |
| Linter / formatter | undecided | `tsc` is strict and there is one author. Adding one now means reformatting the whole tree; ask first |
| Jazz chord-symbol typography — `Δ`, `ø`, stacked alterations | V5 | The engraver superscripts a chord's extensions, which is parity. Being *better* needs the chord grammar (ADR-0012) |
| Beams across rests, cross-beat groups | when a fixture needs one | Nothing in the corpus beams across a rest, and inventing the case would mean inventing the convention too |
