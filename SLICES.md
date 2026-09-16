# sibei-score: Slices

Vertical increments. Each ends in something you can demonstrate, and no slice depends
on a later one. Requirements and shape parts are defined in `PLAN.md`; decisions in
`docs/adr/`.

Two milestones (ADR-0026). **v0.1** is the app without import — useful and shippable on
its own. **v0.2** adds import onto a foundation already proven by use.

Each milestone opens with its riskiest unknown. For v0.1 that was whether a
general-purpose renderer could draw a chart worth printing — asked and answered at the V1
gate, which found VexFlow's output good and decided to own the engraver regardless
(ADR-0030). For v0.2, and for the project as a whole, it is whether oemer's pixel
coordinates are reachable at all.

> **Note, 2026-08-01.** The CLI binary was renamed `sibei` -> `sbscore` (KAN-599, ADR-0008's
> status note), so every command line below reads `sbscore`. Unlike the VexFlow correction
> above, this changed nothing about any slice — not a verb, not an exit code, not a demo step
> — so the command lines are corrected in place rather than annotated: a build plan is
> instructions, and a reader who types the old name gets nothing.

---

# v0.1 — the app without import

## V1: The render gate

**Delivers:** R3 (partial), and the exit condition for ADR-0014

> **History, 2026-07-31.** This slice ran and its gate decided against VexFlow
> (ADR-0030). `packages/draw` and the `vexflow` dependency were removed at V1d and the
> adapter is now `packages/engrave`. The build plan below is kept as written because it
> is the record of what V1 built — read it as history, not as instructions.

The riskiest v0.1 mechanism, taken first. Everything visible in this product flows
through the layout engine and the draw adapter, and if VexFlow's output is not good
enough the decision to replace it should be made now rather than after an app is built
on it.

**Build plan**

1. `model` package: score types — melody voice with explicit rests, beat-anchored
   chords, ties, tuplets, sections, barline kinds, pickup, spelling pins, and the
   confidence and review flag fields v0.2 will set (ADR-0026 requires the fields now to
   avoid a migration later).
2. Metric validity as a derived function over a bar (ADR-0013). No rejection anywhere.
3. `layout` package: the layout contract from `PLAN.md` — four bars per line, broken at
   section boundaries, pickup outside the grid (ADR-0015).
4. `draw` package: VexFlow adapter consuming layout positions only.
5. Server-side SVG → PDF with pinned metadata (ADR-0014).
6. Author the nasty chart as a hand-written fixture: four-bar grid, ties across
   barlines, triplets, a pickup, double barlines, an 11-bar section forcing a 4/4/3
   break, and dense chord symbols including `C7alt` and `F#m7b5`.
7. **Gate:** look at the PDF and decide — keep VexFlow, or own the engraver. Record the
   outcome as a status update on ADR-0014 either way.

**Demo:** run one command against the fixture and open `nasty-chart.pdf`. Every listed
feature is visible, four bars to a line, with the section break landing where the
section ends and not where the grid would put it.

**Rests on assumptions:** Q38 (A4 default, charts flow to more pages) and Q39
(deterministic export, SVG snapshots). If Q39 is wrong the regression test changes
shape, nothing else.

### Test plan

#### End-to-end
- Rendering the nasty chart fixture produces a PDF whose first page contains exactly
  three systems for an 11-bar section, laid out 4 / 4 / 3.
- A pickup bar renders before bar 1 without consuming a four-bar slot.
- Rendering the same fixture twice produces byte-identical PDFs.

#### Integration
- Layout output for the fixture matches a committed SVG snapshot.
- `draw` renders every glyph kind the layout contract can emit, with no unhandled kind.

#### Unit
- Four-bar grid: bar counts of 1, 3, 4, 5, 8, 11 produce the expected systems.
- A section boundary mid-line forces a break; a section boundary on a line boundary does
  not create an empty system.
- Metric validity: bars summing under, over, and exactly to the meter classify correctly
  in 4/4, 3/4 and 6/8.
- `layout` and `model` import nothing framework- or Node-specific.

---

## V1b: The engraver spike

**Delivers:** the exit condition for ADR-0030, and a real estimate for the rest

> **History, 2026-07-31.** This slice ran, the gate passed, and the number it produced —
> 6.5–7.5 focused days to parity — held. The full replacement followed as **V1c** (real
> within-bar spacing and the font seam) and **V1d** (the rest of the glyph set, Petaluma
> as the `jazz` face, `packages/pdf` pointed at the engraver, `packages/draw` and the
> `vexflow` dependency deleted). Neither is written up below; the record is ADR-0030's
> status updates and [`docs/v1b-engraver-spike.md`](docs/v1b-engraver-spike.md). Read
> this slice as history, not as instructions.

The gate decided we own the engraver (ADR-0030). This slice buys the evidence before the
commitment, the same way V1 did: it does not replace anything, it proves the approach and
produces a number.

**Build plan**

1. Read Bravura's `bravura_metadata.json` — glyph anchors (`stemUpSE`, `stemDownNW`) and
   engraving defaults (staff line, stem and beam thickness, beam spacing). This is the
   metrics problem already solved as data; do not re-derive it.
2. A second draw adapter behind the *same* seam, implementing only what one system needs:
   noteheads, stems with direction and length, ledger lines, and **beams** — slope,
   stem adjustment to meet the beam, and a secondary beam for sixteenths.
3. Render one system of the nasty chart through it. Bar 6 is the interesting one: four
   sixteenths with an accidental, which is where beaming is hardest and where V1's bug
   lived.
4. **Side by side.** Both adapters, same music, same layout, one image. `pnpm proof`
   already crops by bar, so this is a comparison rather than an impression.
5. **Gate:** look at both. Confirm the approach is viable, agree the glyph-anchoring
   design, and write down a real estimate for reaching parity. Record the outcome as a
   status update on ADR-0030.

**Demo:** one image, two engravings of bar 6, ours and VexFlow's, at the same scale.

**Rests on assumptions:** that Bravura's metadata is sufficient to anchor stems and beams
without hand-tuned per-glyph offsets. If it is not, the estimate grows and the spike is
exactly where that surfaces.

**Explicitly not in this slice:** rests, ties, tuplet brackets, accidental stacking,
clefs, key and time signatures, barlines, chord symbols, or within-bar spacing. Parity is
a later slice whose position is chosen once this one has given a number (ADR-0030).

### Test plan

#### Integration
- The spike adapter renders the fixture system without throwing, and consumes only the
  layout contract — asserted by the same architecture test that guards the seam.
- Both adapters produce output for the same layout, so the comparison is of engraving and
  not of two different layouts.

#### Unit
- Glyph anchoring: a stem attached at Bravura's `stemUpSE` anchor lands on the notehead's
  right edge, at every staff position.
- Beam geometry: slope stays within the conventional limit; every stem in a group
  terminates on the beam; a group of four sixteenths gets two beams.

---

## V2: One write path

**Delivers:** R1 (partial), R2, R8, R9

**Build plan**

1. SQLite store: `scores(id, owner, title, composer, key, updated_at, version, doc JSON)`
   behind a repository interface (ADR-0006). `owner` is always `local`.
2. `schemaVersion` inside the document, plus the migration runner on read that does not
   bump the score version (ADR-0028).
3. Op log table, and the op applier as the only writer (ADR-0003).
4. `/v1/` API: create, read, list, delete, and `POST /v1/scores/:id/ops` with
   `expectedVersion`. Stale writes return 409 with the current version.
5. Address resolver: `bar12.beat3`, `bar12.n3`, `note-17`, onsets only, errors listing
   the bar's real onsets (ADR-0007).
6. `batch` as a transactional op list.
7. CLI skeleton: `new`, `list`, `open`, `rm`, `note add|set|rm`, `rest`, `--json`
   everywhere, and distinct exit codes for conflict, bad address, and validation failure.
8. `sbscore show`: the text projection (ADR-0009), printing the addresses it accepts.
9. Auth seam resolving `local`, plus the Origin check and the localhost bind before any
   browser client exists (ADR-0029).

**Demo:** author a short chart entirely from the CLI — `sbscore new`, several `note add`
calls — then `sbscore show` it and see the four-bar grid with addresses. Run the same
`note set` twice with a stale `--if-version` and watch the second fail with exit code 4
and the current version.

**Rests on assumptions:** Q77 (`schemaVersion`, forward-only migrations), Q79 (the op
arbitrates), Q78 (Origin check adequate locally).

### Test plan

#### End-to-end
- A chart authored entirely through CLI commands round-trips through `sbscore show` with
  every note at the address it was created at.
- A write with a stale expected version is rejected with the current version, and the
  score is unchanged.
- A `batch` containing one invalid op applies none of its operations.
- Addressing a beat that is not an onset fails with a message listing that bar's real
  onsets.
- A state-changing request carrying a foreign `Origin` is rejected.

#### Integration
- Replaying a score's op log from empty reproduces the stored document exactly.
- The only code path writing to the store is the op applier.
- No API route accepts a host filesystem path, and no response exposes one — the
  hosting-shaped constraint from ADR-0001, asserted rather than assumed.
- No code outside the repository implementation references SQLite, so the store is
  genuinely swappable.
- Every score row has a non-null `owner`, and every score query filters on it even
  though the value is always `local`.
- A document at `schemaVersion` N-1 is migrated on read, used, written back at N, and
  the score's `version` is unchanged.
- A document from a newer schema version than the running code fails loudly.

#### Unit
- Address resolution for beat, ordinal and ID forms, including ordinals in a metrically
  invalid bar.
- Exit code mapping for each failure class.
- Text projection formatting: two chords in one bar, a tie, a triplet, a review flag.

---

## V3: Export from the store

**Delivers:** R0 (first end-to-end path)

Joins V1's renderer to V2's store, so the product does something whole for the first
time.

> **Done, 2026-07-31**, as four sub-cards (KAN-506–509 under KAN-411). **Steps 4, 5 and 6
> below were already built at V1** and the slice discovered it rather than rebuilding them:
> `resolvePageSpec` had A4 and Letter with A4 default, `paginate()` already flowed onto
> further pages, `buildHeader()` already emitted the title block, and the SVG snapshots were
> already in the suite. What was actually missing was steps 1–3.
>
> Two things V1 had *written* but never *exercised* turned out to be where the risk was.
> No fixture had ever spilled onto a second page — a full 32-bar chorus fits one A4 page
> with room to spare — so the pagination branch was correct but unproven, and proving it
> needed a 64-bar fixture. Looking at that second page found three defects the suite had no
> opinion about, one of them a tie drawn through the key signature at bar 9 of the nasty
> chart, wrong since V1.
>
> Q37 and Q81 both picked up dated amendments from contact with the code. Read the build
> plan below as the plan it was.

**Build plan**

1. Wire `layout` and `engrave` to scores loaded from the repository.
2. `GET /v1/scores/:id/export?format=pdf`, streaming from the `BlobStore` (ADR-0006).
   Exports are **generated on demand and cached** in the `BlobStore` keyed by
   `(score version, format, instrument)`, so a version bump invalidates them implicitly.
   This is what reconciles ADR-0016's "an instrument part stores nothing" with ADR-0006
   putting exported PDFs in the blob store: no *score variant* is ever stored, but a
   rendered artefact may be cached (Q81).
3. `sbscore export --pdf`.
4. Page setup: A4 and Letter, A4 default, flowing to further pages (Q38).
5. Chart metadata in the PDF header — title, composer, key, style line — and `meta set`
   on both surfaces (Q37).
6. SVG snapshot regression tests wired into the suite.

**Demo:** `sbscore new`, edit a few notes from the CLI, `sbscore export --pdf`, open the
result. A chart you authored through an agent-shaped interface comes out as a printable
page.

**Rests on assumptions:** Q37, Q38, Q39.

### Test plan

#### End-to-end
- Create, edit and export produces a PDF containing the edited notes and the metadata
  header.
- A chart longer than one page flows onto a second page with the four-bar grid intact
  across the break.
- Letter and A4 both produce valid output with different page dimensions.

#### Integration
- Export reads through the repository and writes through the `BlobStore`, with no direct
  filesystem access.
- Exporting an unchanged score twice yields identical bytes.

#### Unit
- Pagination: systems-per-page for A4 and Letter at the chosen staff size.

---

## V4: The browser

**Delivers:** R1

> **History, 2026-09-10.** Shipped as four sub-cards V4a–V4d (KAN-587–590 under KAN-412), not the
> six build-plan steps below. V4a (the change bus and `GET …/events`) went first and in parallel;
> V4b the read-only Svelte shell; V4c hit-testing, the inspector and edits as ops; V4d wired the
> stream into the open score view and added the boots-the-whole-stack E2E (`tests/browser/`,
> Playwright driving a real Chromium in the infra layer) and this slice's demo (`pnpm demo:v4`).
> Read the plan below as the record of intent; the cut is on the board and in git. One knowing gap
> remains against Q79: `score.create` and `meta.set` have no UI control yet.

**Build plan**

1. Svelte 5 + Vite shell (ADR-0022); library view listing charts with search.
2. Score view rendering through the *same* `layout` package the server uses, drawing to
   SVG in the browser.
3. Hit-testing on the SVG to select a note; inspector for pitch, duration, accidental.
4. Edits submit ops to the same API the CLI uses — no second write path.
5. SSE push so an external change repaints the open score.
6. The dependency test asserting `model`, `music`, `layout` and `codec` stay
   framework-free.

**Demo:** open a chart in the browser, change a note's pitch by clicking and typing. Then
in a terminal run `sbscore note set` on the same chart and watch the browser update without
a reload. The two surfaces visibly cannot disagree.

**Rests on assumptions:** none new.

### Test plan

#### End-to-end
- Editing a note in the browser changes the stored score, and `sbscore show` reflects it.
- A CLI edit appears in an open browser view without a reload.
- Two browser tabs on one score stay consistent after an edit in either.

#### Integration
- The browser and the server produce identical layout output for the same score.
- A browser edit submitted against a stale version surfaces a conflict and recovers by
  re-reading rather than overwriting.

#### Unit
- Hit-testing maps SVG coordinates to the correct note, including in a bar with a tie.

---

## V5: Chords

**Delivers:** R3 (partial)

> **Note, 2026-09-10.** Being cut into sub-slices V5a–V5e (grammar, corrector, ops+CLI, engraver
> typography, browser), landed as separate PRs the way V2–V4 were. Two corrections against contact
> with the code, per AGENTS.md's "trust the code": the `Chord` model field and beat-anchored chord
> *addressing* already existed from V1 (`resolveBeat` handles `looking: 'chord'`), so step 2 is the
> ops and the applier, not the address scheme. And step 5's `Ebm7@1, Bb7@3` is conceptual shorthand
> for beat placement — the projection has rendered chords in its **four-bar grid** since ADR-0009's
> worked example (`1 |Ebm7  Ab7|…`), not with an `@beat` syntax — so step 5 is delivered by that
> grid, and the corrector (ADR-0011) is added alongside the grammar as its own sub-slice.

**Build plan**

1. `music` package: chord grammar — parse and format root, quality, extensions,
   alterations, bass (ADR-0012). Unparseable text is retained verbatim and flagged.
2. `chord.set` and `chord.rm` ops, anchored to a beat within the bar (Q32).
3. Chord rendering above the staff through the engraver. Superscripted extensions
   already ship — that was parity with what VexFlow did. What this slice adds is the
   jazz typography ADR-0030 named as V5's: `Δ`, `ø`, stacked alterations, parenthesised
   extensions, which need the grammar from step 1 to know what they are.
4. Chord editing in the browser with grammar validation as you type; `sbscore chord set`.
5. Chords in the text projection as `Ebm7@1, Bb7@3`.

**Demo:** type `F#m7b5` above bar 3 in the browser and see it engraved with a proper
superscript. Add a second chord on beat 3 of the same bar from the CLI. Type nonsense and
watch it stored verbatim and flagged rather than rejected.

**Rests on assumptions:** none new. Note this slice builds the mechanism that v0.2's OCR
correction depends on (ADR-0011), so its test suite is doing double duty.

### Test plan

#### End-to-end
- A chord entered in the browser appears in the PDF, in the text projection, and via the
  CLI at the same beat.
- Two chords in one bar render at their correct beat positions.
- Unparseable chord text is stored, flagged, rendered verbatim, and exported.

#### Integration
- Chord symbols survive a MusicXML export and re-import with their structure intact
  where MusicXML can express it, and the lossy cases are documented by the test.

#### Unit
- Grammar parses `C`, `Cmaj7`, `Cm7`, `F#m7b5`, `C7alt`, `Bb13#11`, `Ab/Eb`, `N.C.` and a
  list of real-world spellings.
- Formatting round-trips every parsed structure back to its canonical text.
- The grammar corrector snaps a set of realistic OCR mangles to the intended symbol.

---

## V6: Transpose and parts

**Delivers:** R4

> **Done, 2026-09-10**, as five sub-slices V6a–e landed as separate PRs the way V2–V5 were. V6a: the
> enharmonic spelling engine (`model/spelling.ts`), pure and framework-free. V6b: the `transpose` op
> and `sbscore transpose --to`. V6c: instrument parts as a render-time view — `writtenPart` and the
> five instruments, reusing the export cache key's reserved `instrument` dimension (V3/Q81), plus
> `export --for`. V6d: `--spell` pins on notes and chords, which gave `Chord` a `spellingPinned`
> field — the **first real schema migration** (v1→v2, ADR-0028), and it reworked the two migration
> test suites that had been rehearsing a synthetic one. V6e: the browser controls — a Transpose
> action, a Part picker that previews the written part on the sheet (read-only, since a part is not
> the concert truth), and a spelling-pin toggle in both inspectors. `writtenPart` moved from
> `packages/api` to `packages/music` at V6e so the browser could render a part without importing the
> server. Read the build plan below as the plan it was.

**Build plan**

1. Enharmonic spelling engine: key-signature-driven, with per-object pins that survive
   transposition (ADR-0017).
2. `transpose` op — a mutation, logged and undoable (ADR-0016).
3. Instrument part generation as a render-time view: bb-trumpet (M2), bb-tenor (M9),
   eb-alto (M6), eb-bari (M13), f-horn (P5), each changing written octave and key
   signature.
4. Chord roots transpose with the written pitch on a part.
5. `--spell` on note and chord ops; `sbscore transpose --to`; `sbscore export --for
   bb-trumpet`.

**Demo:** transpose a chart in C to Eb and see Bb and Ab in the melody, never A# or G#.
Then export a Bb-tenor part from the concert chart and check it is written a major ninth
up, in the right key signature, with the chord symbols moved to match.

**Rests on assumptions:** none new.

### Test plan

#### End-to-end
- Transposing to Eb respells the melody and chord roots per the key signature, and the
  operation is undoable.
- A bb-tenor part is written a major ninth above concert with the correct key signature,
  and the stored score is unchanged by the export.
- A pinned spelling survives a transposition.

#### Integration
- Every supported instrument produces a part with the correct interval, written octave
  and key signature.

#### Unit
- Transposition intervals for all five instruments, including octave displacement.
- Spelling choice for every degree in every major key.
- Chord root respelling under transposition, including slash-chord bass notes.

---

## V7: Structure and page

**Delivers:** R3

**Build plan**

1. Section and rehearsal-letter model objects and ops.
2. Repeat barlines with 1st/2nd endings; double barlines; pickup identification.
3. Section-driven line breaking wired into `layout` (ADR-0015) — the grid already
   supports it from V1, this connects it to real user-set sections.
4. Structure panel in the browser; `sbscore section set`, `sbscore repeat set`.
5. Rendering all barline kinds and endings in both screen and PDF.

**Demo:** build a 32-bar AABA chart with a pickup, rehearsal letters and a repeated A
section, and export it. Line breaks fall at section boundaries, the repeat and endings
render correctly, and the pickup sits outside the grid.

**Rests on assumptions:** Q34 (one time signature per chart).

### Test plan

#### End-to-end
- An AABA chart with a pickup and repeats exports with line breaks at every section
  boundary.
- A section whose length is not a multiple of four breaks as 4 / 4 / remainder.
- 1st and 2nd endings render over the correct bars.

#### Integration
- Setting a section via the CLI changes the layout the browser renders.

#### Unit
- Every barline kind maps to a distinct glyph.
- Rehearsal letters attach to the correct bar after notes are inserted before them.

---

## V8: Undo, MusicXML, and the library

**Delivers:** R1, R7 (for v0.1), and completes v0.1

> **Note, 2026-09-10.** Being cut into sub-slices V8a–V8f, landed as separate PRs the way V2–V7
> were: (V8a) undo/redo, (V8b) the `codec` package, (V8c) library delete/duplicate, (V8d) the
> migration fixture test, (V8e) the container, (V8f) the docs. **V8a, V8b, V8c and V8d are done** —
> V8b landed the `codec` package (score ↔ MusicXML string, single-voice) as a pure engine the way V6a
> landed the spelling engine; V8c added library delete and duplicate (duplicate as a fresh-history
> copy via a server-only `score.import` op); V8d wired MusicXML **export** through the API route and
> `sbscore export --musicxml`, and V8e added its **PDF | MusicXML rail toggle** in the score view
> (MusicXML *import* is the only codec surface still to follow); V8f added the migration fixture test
> — a whole v1 chart carried to the current schema — which caught and fixed a real gap (the v1→v2
> step had backfilled `spellingPinned` onto chords but not notes). Two corrections
> against contact with the code (AGENTS.md's "trust the code"): step 1 reads "minus the last
> *operation*", but ADR-0003 makes a **batch** one undoable unit, so undo drops the last *batch* —
> the demo's eight-edit batch reverts as one. And because the op log is append-only forever
> (ADR-0003; nothing UPDATEs or DELETEs a row) and `replay(log) == stored doc` is a tested property,
> undo cannot delete rows or overwrite the document blindly: it appends an `undo`/`redo` **control
> operation** that `replayLog` resolves, which needs no schema change and no inverse operations. This
> also settled KAN-510 (the op log's read shape): the surface is `ScoreReader.operations`, read
> inside the applier, with `POST /v1/scores/:id/undo|redo` as the write routes.
>
> **Update, 2026-09-11. v0.1 is complete.** The cut ran past the V8a–V8f labels above;
> `agent_docs/history.md` carries the real order. Done through **V8i**: V8e became the export-format
> toggle, V8f the migration fixture, V8g the API serving the built UI (`sbscore serve --ui`, an fs-free
> `AssetSource` port), V8h **the container** (step 5) — a `Dockerfile` + `compose.yaml` running
> `sbscore serve --ui` on `127.0.0.1:8080` with a named volume — and V8i the **v0.1 docs** (step 6): the
> README (install both ways, the offline claim), the CLI reference (`docs/cli.md`), and the hosted
> direction (`docs/hosting.md`). The container forced an **amendment to ADR-0029**: it separates the
> *bind* address (the container binds `0.0.0.0` so Docker's published port reaches it) from the *publish*
> address (the compose file publishes to the host's loopback only), which is where LAN-unreachability is
> now enforced. Still to come, in v0.2: MusicXML import and the OMR pipeline.

**Build plan**

1. Undo and redo by replay of the op log minus the last operation (ADR-0003), exposed as
   `sbscore undo` / `redo` and ctrl-Z, with an agent `batch` undoing as one unit.
2. `codec` package: MusicXML export and import, single-voice lead sheets only (ADR-0004).
3. Library polish: search, delete, and duplicate.
4. Migration fixture test carrying a document through every schema version.
5. **Ship it as a container.** Dockerfile for the `api` image serving the built UI, a
   compose file, and a persistent volume for the SQLite database and blobs. v0.1 has no
   worker, so this is a single-container deployment that V10 later extends rather than
   replaces. This is what makes R7 true for v0.1 rather than only for v0.2.
6. v0.1 documentation: install, the CLI reference, and the offline claim stated plainly.

**Demo:** have an agent make a batch of eight edits, then press ctrl-Z once in the
browser and watch all eight revert together. Export MusicXML and open the chart in
MuseScore.

**Rests on assumptions:** none new.

### Test plan

#### End-to-end
- An agent's batch of eight edits undoes as a single step; eight individual edits undo
  one at a time.
- Undo then redo returns to the identical document.
- Exported MusicXML opens in a third-party application with melody, chords and structure
  intact.
- `docker compose up` on a clean machine serves the UI, and the CLI reaches it on
  `localhost:8080` with no host-side setup beyond the binary.
- Data survives a container restart.
- The container runs with networking disabled apart from the published port.

#### Integration
- MusicXML round-trip preserves everything the format can express; every lossy case is
  named in a test rather than discovered later.
- A fixture document migrates from the earliest schema version to the current one.

#### Unit
- Undo at the first operation, and redo past the head, both behave rather than error
  obscurely.

---

# v0.2 — import

## V9: The oemer coordinate spike

> **Update, 2026-09-11. Done. Gate: PROCEED TO V10.** The coordinates are reachable
> in-process, as a library, without a vendored fork — Q71 is verified true and ADR-0023's
> exit condition is met (recorded as a status update on ADR-0023). The worker lives at a new
> top-level `worker/` (Python, outside the pnpm workspace, ADR-0005); `worker/sibei_omr/spike.py`
> replicates oemer's stage sequence up to its `layers` registry and dumps every
> `Staff`/`NoteHead`/`NoteGroup`/`Barline`/`Rest` with pixel coordinates to JSON. The output
> schema is model-owned (`packages/model/src/omr.ts`), and the three test-plan checks below run
> in CI against the committed real dump (`tests/fixtures/omr/aaba-chart.omr.json`) as pure
> TypeScript — the spike needs Python + weights and stays standalone. CPU wall-clock and the
> dependency-pinning findings (oemer 0.1.8 not 0.1.7; onnxruntime < 1.19; opencv < 5; numpy < 2)
> are in `worker/README.md` and on ADR-0023. There are no real photos in the repo, so the spike
> ran on a rendered fixture (ADR-0018/ADR-0020); the wall-clock is a best-case lower bound and
> real-photo robustness is V10 evaluation work.

**Delivers:** the exit condition for ADR-0023, and the measurement ADR-0025 needs

The riskiest unknown in the entire project, confronted before anything is built on it. If
the coordinates are not reachable, stage 3 of the pipeline cannot be built as designed
and the contingency (a vendored fork) has to be chosen with eyes open.

**Build plan**

1. Python project skeleton with oemer pinned to an exact version.
2. Load oemer **as a library**, not via its CLI, and run it in-process on a real photo of
   a printed chart.
3. Reach the internal `Staff`, `NoteHead`, `NoteGroup`, `Barline` and `Rest` objects and
   dump each one's coordinates and attributes to JSON.
4. Measure CPU-only wall-clock on three representative photos, and again with a GPU if
   one is available.
5. **Gate:** coordinates reachable → proceed to V10. Not reachable or unusable → decide
   between vendoring a fork and re-deriving coordinates from segmentation output, and
   record the decision as a status update on ADR-0023.

**Demo:** run one script on a photo and get a JSON file listing every detected note and
barline with pixel coordinates, plus a printed wall-clock figure.

**Rests on assumptions:** Q71, which is precisely what this slice exists to verify. If
wrong, V10 through V13 all change shape, which is why nothing is built before it.

### Test plan

#### End-to-end
- Running the spike on a fixture photo produces JSON containing at least one staff, and
  notes and barlines each carrying non-null pixel coordinates.

#### Integration
- The dumped coordinates land inside the source image's bounds, and note coordinates fall
  within their staff's vertical extent.

#### Unit
- The dumped structure conforms to the worker output schema owned by the `model` package.

---

## V10: The worker, offline and in a job

> **Update, 2026-09-11. Landed (Node side + worker + Docker authored).** OMR is now a job, not a
> request (ADR-0001). The V9 spike is promoted into a recogniser (`worker/sibei_omr/recognize.py`)
> behind an HTTP worker (`server.py`); the API validates an upload by decoding it (ADR-0029), stores
> it in the BlobStore, records a durable job (the `JobStore` port + its SQLite `import_jobs` table),
> and a background runner calls the worker across a `WorkerClient` port (ADR-0005) and stores the raw
> `OmrDocument`. A failed import records a diagnostic, is retryable, and commits nothing (Q80); the
> API is fully functional with the worker stopped, and with no worker configured import is a 503 and
> all else works. Progress rides an SSE job stream, the sibling of V4's change stream. The `worker`
> Dockerfile bakes + checksums the weights at build time (ADR-0024) and the compose file adds the
> second container (Q44); GPU is a separate opt-in image (`Dockerfile.gpu` + `compose.gpu.yaml`,
> ADR-0025). **Scope note:** V10 stores the *raw recognised objects*, as its demo says — mapping them
> onto a `Score` and landing them via `score.import` is V11's named deliverable, so no score is
> created here. **Two contact-with-code notes:** (1) the GPU "compose profile" the plan names is an
> *override file*, not a `profiles:` key — a profile cannot swap a service's image without
> duplicating the service (recorded in `compose.yaml` and ADR-0025's consequences). (2) The Docker
> image build and the networking-disabled offline test require a Docker/Podman host; where those were
> unavailable they are authored and reviewed, with the offline property asserted by construction (the
> image fetches weights only at build time) rather than executed — see the worker README.

**Delivers:** R7 (fully, including the offline guarantee), R5 (infrastructure)

**Build plan**

1. Dockerfile for the worker with **all** model weights fetched at build time and
   verified against pinned checksums (ADR-0024).
2. Compose topology: `api` and `worker`, plus an opt-in GPU profile that changes speed
   only (ADR-0025, Q44). Note the GPU profile needs `onnxruntime-gpu` and a pinned CUDA
   version, so it is a separate image variant rather than a runtime flag — build both or
   document the GPU image as build-it-yourself.
3. Job runner in the API: submit, run, poll, and SSE subscribe (ADR-0001).
4. Failure handling — a failed job records a diagnostic, is retryable, and commits
   nothing (Q80).
5. Upload boundary: decode to validate, with dimension and size caps (ADR-0029).
6. The API remains fully functional with the worker stopped.

**Demo:** start the stack with networking disabled, submit a photo, watch the job progress
and complete, and see the raw recognised objects stored. Then stop the worker and confirm
every non-import feature still works.

**Rests on assumptions:** Q44, Q80, Q26 (an import may take several images).

### Test plan

#### End-to-end
- An import runs to completion in a container **with networking disabled**.
- Killing the worker mid-import leaves the job `failed` with a diagnostic and the score
  untouched.
- With the worker stopped, creating, editing and exporting a chart all still work.
- An upload that is not a decodable image is rejected at the boundary.

#### Integration
- The build fails if a model checkpoint's checksum does not match.
- The GPU profile and the CPU profile produce identical output on one fixture.
- The worker's returned document validates against the `model` schema.

#### Unit
- Job state transitions, including retry after failure.
- Upload validation: oversized, zero-byte, wrong-format, and dimension-bomb inputs.

---

## V11: Photo to editable draft

> **Update, 2026-09-11. Landed (the mapper, the applier import path, the runner, both surfaces).**
> A recognised import now becomes an editable draft `Score`. The crux is a pure, framework-free
> **mapper** (`packages/model/src/omr-map.ts`, `mapOmrToScore`): it collapses oemer's per-track staff
> grid into systems (ignoring the unreliable `zones` layer, V9 finding), segments bars from
> deduplicated barlines, orders notes/rests by x into sequential onsets, reads pitch from staff
> geometry against a treble clef, computes per-bar metric validity, flags what it is unsure of
> (ADR-0013, ADR-0019), and joins several pages in order (Q26). Being pure TS over the committed real
> dump, it is fully fast-layer tested here without oemer (`tests/unit/omr-map.test.ts`). The runner
> maps → lands the score through a new **server-only `Applier.import`** (folds one `score.import`,
> like `duplicate`, ADR-0003/0008) → records `job.scoreId` (V10's `null` is gone). The transport now
> accepts several images as `multipart/form-data` (Q26); `sbscore import <file>...` and a **library
> import affordance** both land (Q79). A no-staff image fails cleanly (ADR-0018/Q28); the source
> images are retained in the BlobStore (ADR-0019). See `agent_docs/history.md` for the cut.
>
> **The schema-gap decision (confirmed with the maintainer): default and flag, defer detection.**
> The `OmrDocument` the worker emits carries staves, noteheads, note groups, single barlines and rests
> — and **nothing else**. It omits clef, key-signature accidentals, time signature (build-plan item 2's
> "key and time signature"), **and ties and tuplets/triplets** (build-plan item 2's "ties, triplets").
> The worker computes clef/sfn layers internally but does not register them in the schema. So V11 maps
> what is actually emitted, defaults key = C major / time = 4/4, reads pitch against a treble clef, and
> produces no ties or triplets — every gap a flagged draft the human corrects (ADR-0019). Detecting
> clef/key/time/ties/triplets needs the worker **and** the schema (`packages/model/src/omr.ts`,
> `OMR_SCHEMA_VERSION`) extended **and a fresh real-oemer fixture** — none of which could be produced or
> verified in the environment V11 was built in (no oemer, no Docker: that host's org egress policy
> blocked every container registry, so no base image was pullable). [**Corrected at V12:** that was a
> property of *that* build host, not the project. On a host with Docker + registry access the worker
> image builds and oemer runs (V9's pins hold), so the blocker on a real-oemer fixture is registry
> access plus RAM, not a standing limitation — see the V12 note.] Rather than ship untested Python and a
> fabricated fixture, this is deferred to a host with oemer/registry access, and it is a **documented
> deviation from ADR-0021**'s "key and time signature … detected on import". Build-plan item 1 (explicit
> preprocessing) is likewise deferred: `recognize.py` already deskews/dewarps via oemer, and explicit
> crop/contrast is untestable here.
>
> **Two plan/code discrepancies, surfaced per AGENTS.md rather than worked around:**
> - The E2E clause "undoing an import leaves an empty score" conflicts with ADR-0003's undo *floor*.
>   V11 lands import as a **new** score (the create-from-document path, exactly like `duplicate`), so
>   its single `score.import` op is the floor: undo is a no-op there and the score is removed by
>   *delete*, not undo — the same behaviour `duplicate` has. The replay property still holds exactly
>   (asserted in `tests/api/applier.test.ts`). Reading the clause literally would mean import-into-an-
>   existing-empty-score, which is not the V10 job model (a job creates a new score and fills `scoreId`).
> - `sbscore import` does not take `--title`/`--composer`: OCR of title/composer (Q37) needs OCR the
>   pipeline does not run until V13, and `ScoreMeta` has no review field to flag them low-confidence.
>   The title defaults empty (KAN-594); the user sets it with `meta set` after. Deferred with the OCR.
>
> The live-worker end-to-end demo (a real phone photo through the real oemer container to a PDF) cannot
> run here for the same registry reason; it is verified against the committed dump and a fake-worker
> browser E2E instead, and the real-container run is deferred to a host with registry access. Read the
> build plan below as the plan it was.

**Delivers:** R5

**Build plan**

1. Preprocessing in the worker: deskew, perspective correction, crop to page, contrast
   normalisation via OpenCV (Q27).
2. Map oemer's objects to the score model — notes, rests, ties, triplets, single barlines,
   key and time signature (ADR-0018, ADR-0021: barline *type* is not detected).
3. Metric-validity flags computed per bar; invalid bars stored and flagged, never
   repaired (ADR-0013).
4. Import as one op carrying the whole document (ADR-0003), so it is undoable and the
   replay property holds.
5. Retain the source image in the `BlobStore` permanently (ADR-0019).
6. `sbscore import <file>...` and the library's import affordance.
7. Title and composer OCR-attempted, flagged low-confidence (Q37).

**Demo:** photograph a printed lead sheet, `sbscore import` it, open it in the browser, and
export a PDF. A paper chart becomes a printable digital one, warts included.

**Rests on assumptions:** Q27 (auto preprocessing only), Q28 (partial with flagged gaps),
Q37, Q26.

### Test plan

#### End-to-end
- Importing a fixture photo produces a score whose bar count matches ground truth and
  which opens, edits and exports normally.
- Importing an image with no detectable staff fails cleanly rather than creating an empty
  score.
- Undoing an import leaves an empty score, and the op log still replays exactly.
- A two-image import produces one chart with the pages in order.

#### Integration
- Metrically invalid bars from a real parse are stored and flagged, never rejected.
- The source image is retrievable from the `BlobStore` after import.

#### Unit
- oemer object → model mapping for each object kind, including ties and triplets.
- Preprocessing: a deliberately skewed and shadowed fixture deskews within tolerance.

---

## V12: The evaluation harness

> **Update, 2026-09-14. Landed (the harness; the real oemer baseline as far as the host allows).**
> The measurement now exists. It is built in four sub-slices (V12a–d) landed as stacked PRs the way
> V2–V11 were, and around **one deviation confirmed with the maintainer: `packages/synth` is created
> here, a slice ahead of V15's build-plan-item-1**, so v0.3's synthetic generator *extends* it rather
> than duplicating the render+degrade kernel (the ADR-0031 §"One invariant exception" grant, taken up
> early). **V12a** is the pure core (`packages/synth`: a seeded PRNG, `generateScore` — plausible
> diatonic lead sheets with metrically-valid bars, ground-truth `labels`, and note/chord/valid-bar
> `metrics` by LCS+Levenshtein alignment), plus the inverse `tests/arch` guard that keeps the
> build-time tool out of every shipped bundle. **V12b** is the imaging half behind `@sibei/synth/imaging`
> (native, so it is kept off the fast layer's dlopen trap): `renderScoreToPng` (the layout+engrave
> composition, not `@sibei/pdf`, ADR-0014) and a seeded, deterministic `degrade` — perspective (a
> hand-rolled homography, since sharp has no perspective op), blur, shadow, paper texture, noise, JPEG.
> **V12c** is `runEval` + `scripts/eval.ts` + `pnpm eval`/`make eval` + `docs/eval.md` (the metric
> definitions and the human-time ship gate as a repeatable stopwatch procedure) + the
> `tests/fixtures/eval/real/` control-set scaffold + per-run `eval/history.jsonl`. **V12d** is this
> status note and the rest of the docs.
>
> **Two corrections against contact with the code (AGENTS.md's "trust the code"):**
> - Build-plan item 1 says "render known **MusicXML** to images". The generator renders a `Score`
>   directly through `layout`+`engrave` — MusicXML is a codec at the edges (ADR-0004), not the render
>   input, and the `Score` *is* the ground truth for free, which is the whole point (ADR-0020/0031). So
>   the corpus is generated `Score`s, not round-tripped MusicXML.
> - The recogniser is an **injected `Predict` seam**, so the harness scores oemer today and v0.3's
>   bespoke engine later unchanged (ADR-0005) — and is fully testable without oemer (a fake predictor
>   proves the sensitivity: a degraded corpus scores below a clean one).
>
> **The "no oemer / no Docker" limitation in the V10/V11 notes below was true on *that* build host, not
> on all of them.** On a host with Docker + registry access (this one), the worker image builds and
> oemer runs — verified: the image built, the worker came up healthy (oemer 0.1.8, CPU provider). So
> reaching a real baseline is a question of **RAM, not access.** oemer peaks ~7 GB (V9), and on this
> 8 GB / earlyoom host the real recognition **was OOM-killed** — the container exited 137 as oemer
> loaded its model, and the harness failed cleanly with a diagnostic (the Q80 mid-import-death
> behaviour, reached through the real path). So the real oemer **baseline is deferred to a bigger host**;
> the synthetic-per-level table stands on its own, and `make eval --engine fixture` exercises the whole
> harness without oemer. The OOM is not a bug — it is direct evidence for v0.3's RAM premise (ADR-0031),
> the very reason the milestone exists.

**Delivers:** R6 (the measurement), and the gate ADR-0011 stage 2 depends on

Deliberately before the chord pipeline, so chord accuracy is measured from its first
commit rather than assessed by eye afterwards (ADR-0020).

**Build plan**

1. Synthetic corpus generator: render known MusicXML to images, then degrade — blur,
   skew, perspective, JPEG noise, paper texture, shadow.
2. Metrics: note-level accuracy, chord-level accuracy, percentage of metrically valid
   bars, and once V13 lands, barline and section counts.
3. A small hand-labelled control set of real photos, **deliberately including bad ones**,
   to keep the synthetic set honest.
4. `make eval` printing a metrics table, and the per-run history kept so regressions are
   visible.
5. Write down the human-time ship gate as a repeatable procedure, not a vibe: a named
   32-bar fixture, a stopwatch, a definition of "corrected".

**Demo:** `make eval` prints accuracy across the synthetic corpus and the real control
set, side by side, with the gap between them visible.

**Rests on assumptions:** Q41 (synthetic ground truth is representative enough), Q42 (the
human-time gate is the right criterion).

### Test plan

#### End-to-end
- `make eval` runs the full pipeline over the corpus and emits a metrics table.
- A deliberately degraded corpus scores measurably worse than the clean one, confirming
  the harness is sensitive to what it claims to measure.

#### Integration
- The generator produces images whose ground truth matches the source MusicXML exactly.

#### Unit
- Each metric on hand-built cases including empty output, perfect output, and off-by-one
  bar alignment.
- Each degradation is deterministic given a seed passed in, so runs are comparable.

---

## V13: Chords from the photo

> **Update, 2026-09-14. Landed, in five stacked sub-PRs V13a–e (the V12 pattern), plus one
> deliberate addition confirmed with the maintainer: the v0.3 engine seam pulled forward.** The chord
> pipeline is built and, crucially, **runs end to end on the small build host** — the RAM wall that
> OOM-kills oemer here is oemer-specific, and V13's chord work (PaddleOCR + the corrector + beat
> mapping) is light. **V13a** extends the worker-output schema: `OmrDocument.bandTokens`
> (`{text, bbox, confidence, group}`), `OMR_SCHEMA_VERSION` 1→2, both sides (`packages/model/src/omr.ts`,
> `worker/sibei_omr/recognize.py`). **V13b** is the measurable core — a pure-TS mapper step in
> `mapOmrToScore`: each band token is snapped to a legal chord (the **V5 grammar corrector**, injected
> as a seam because `model` cannot import `music`, ADR-0011/0005) and **beat-mapped** to the note/rest
> onset at or before its box (stage 3, Q71), or kept as a flagged `Annotation` (Q56); OCR confidence
> and low-confidence flags ride into the model (ADR-0019). **V13c** pulls v0.3's engine-selection seam
> (SLICES V15, ADR-0031) forward: `worker/sibei_omr/engines/{oemer,heuristic}`, chosen by
> `--engine`/`$SIBEI_OMR_ENGINE`, oemer the default. The **heuristic engine** is OpenCV-only (no ML
> weights, low RAM) so the whole photo→draft→PDF flow and `make eval` run where oemer is OOM-killed —
> **dev/test scaffolding and the seed of the bespoke direction, NOT the trained V15/V16 model, and it
> earns no default swap** (a swap is decided on the V12 harness, ADR-0020, never by fiat). **V13d** adds
> the chord band: `worker/sibei_omr/band_ocr.py` crops the strip above each staff and runs **PaddleOCR**
> (ADR-0027) on both engines, emitting `bandTokens`; offline weights are baked (ADR-0024). **V13e**
> surfaces a flagged import chord's confidence in the text projection (`Cmaj7!62`, respecting ADR-0009's
> "lossy by design": unflagged confidence and annotations stay in the structured dump / score view) and
> lands these notes.
>
> **Measured:** the heuristic engine + PaddleOCR lifted `chordF1` from 0.000 to **0.100** on the
> synthetic corpus, end to end on the 8 GB host — the whole flow works and the number is real.
> **Deferred to a bigger host** (author + reviewed, the V10/V11 discipline): the **oemer** chord
> baseline (the ADR-0011 stage-2 target), the full PaddleOCR+oemer co-install on py3.11, and the image
> build — this host ran the heuristic engine + PaddleOCR in a light venv.
>
> **A decision from the corpus, surfaced not worked around:** rehearsal letters and sections are **not
> created**. ADR-0021 is explicit that both are "supported … but not detected"; a lone A–G is a legal
> chord *and* a plausible rehearsal letter and the schema carries no box/position cue to tell them
> apart, so a readable token becomes a chord and the human promotes a genuine rehearsal mark to a
> section in correction (V14) — which ADR-0021 already requires. This is the documented reading of Q56's
> "matched separately by pattern": non-chord text is kept and flagged; auto-structure is not. Read the
> build plan below as the plan it was.

**Delivers:** R5 (completes the pipeline)

**Build plan**

1. Staff segmentation and chord-band cropping (ADR-0010 stage 1).
2. PaddleOCR on the cropped band (ADR-0027).
3. The grammar corrector from V5, snapping OCR output to the nearest legal chord symbol
   (ADR-0011) — reusing the mechanism rather than building a second one.
4. Beat mapping: align chord bounding boxes to note and barline X-coordinates from V9
   (stage 3).
5. Non-chord text in the band retained as a flagged bar annotation; rehearsal letters
   matched separately by pattern (Q56).
6. Per-object confidence carried into the model.
7. Re-run `make eval` and record chord accuracy as the baseline that stage 2 fine-tuning
   must beat.

**Demo:** import a photo of a chart with dense chords and see them land above the right
beats, with the uncertain ones flagged. `make eval` reports a chord accuracy figure.

**Rests on assumptions:** Q56 (chords live above the staff; ones elsewhere are missed),
Q74 (PaddleOCR), and Q71 transitively — beat mapping cannot work without V9's
coordinates.

### Test plan

#### End-to-end
- Importing a fixture photo places chord symbols in the correct bars at the correct
  beats, measured against ground truth.
- A bar with two chords maps both to their own beats.
- Non-chord text in the chord band survives as a flagged annotation rather than becoming
  a bogus chord.

#### Integration
- The grammar corrector improves chord accuracy on the corpus relative to raw OCR
  output, and the harness shows by how much.
- Confidence values reach the model and appear in the text projection.

#### Unit
- Beat mapping: a chord box between two note onsets resolves to the earlier beat.
- Chord-band cropping on staves at varying vertical positions and skews.

---

## V14: Correcting a parse

> **Update, 2026-09-14. Landed, in seven stacked sub-PRs V14a–g (the V12/V13 pattern).** Correction is
> built and **v0.2 (import) is complete — V9–V14 have all landed.** Every parse is a draft the human
> fixes against the photo (ADR-0019), reachable from both surfaces. **V14a** retains the source: the
> reverse lookup `JobReader.getByScoreId` (a store method, not a `Score` schema change) plus
> `GET /v1/imports/:jobId/images/:index`, which streams the kept scan bytes with a content-type read
> from them. **V14b** is the split-pane review: `GET /v1/scores/:id/source` (`ImportService.source`)
> answers `{jobId, imageCount}` for an imported chart and `{jobId: null, imageCount: 0}` for a
> hand-authored one — always 200, so the score view can ask it of *any* chart — and `SourcePane.svelte`
> lays the source image beside the rendered score. **V14c** shades the review on the score surface, in
> `packages/engrave`: a rose wash behind a metrically-invalid bar (ADR-0013) and a yellow wash behind a
> low-confidence flagged object (ADR-0019), with a `reviewChart` fixture that enters the byte-identical
> (ADR-0014/0015) and snapshot suites so the shading is one render path like everything else. **V14d**
> is the no-sections advisory: `reviewSummary().hasSections` drives `NO_SECTIONS_ADVISORY` on both
> surfaces (import never detects sections, ADR-0021, and layout silently depends on them, ADR-0015), and
> a flag-parity integration test pins that `sbscore show`'s `!` flags and the browser's are the same set
> for the same score. **V14e** is re-parse: `POST /v1/scores/:id/reparse` (`ImportService.reparse`)
> reuses `getByScoreId` → the same `imageKeys`, no re-upload → the runner → the server-only
> `Applier.import` (ADR-0003/0008) → a **new** draft, the original untouched; `sbscore reparse <id>
> [--engine oemer|heuristic]` and a UI Re-parse control, with `engine` threaded end-to-end to the worker
> (ADR-0005; the job table went schema v3→v4 to carry it, the worker resolves it per-request) and a
> `422 unsupported-engine`. **V14f** wrote and ran the V12 human-time ship-gate procedure into
> `docs/eval.md`; the gate run itself is **deferred** — its 32-bar fixture is not yet committed. **V14g**
> is this note and the docs closeout (AGENTS.md, `docs/cli.md`, this file, the server route table).

**Delivers:** R6

**Build plan**

1. Split-pane score view: source image beside the rendered score, scrollable and
   zoomable (ADR-0019).
2. Confidence highlighting and invalid-bar shading on the score surface.
3. The `!` review flags in `sbscore show`, so a human and an agent are pointed at the same
   places.
4. A prompt when a score has no sections, since layout silently depends on them and
   import never detects them (ADR-0021, ADR-0015).
5. `sbscore reparse <id>` re-running the pipeline from the retained image.
6. Run the human-time ship gate procedure from V12 and record the result.

**Demo:** import a chart with a deliberately poor photo, then use the flags to correct it
while watching the source image. Time it against the two-minute gate for a 32-bar head.

**Rests on assumptions:** Q27 — if automatic preprocessing cannot cope with real photos,
this is the slice that grows a crop UI. Q42 (the gate itself).

### Test plan

#### End-to-end
- A 32-bar fixture parse is correctable to ground truth, and the elapsed time is recorded
  against the gate.
- Every flagged object is reachable and correctable from both the browser and the CLI.
- A score with no sections shows the prompt; adding sections changes the layout.
- `sbscore reparse` produces a fresh draft from the stored image without a new upload.

#### Integration
- Flags shown in the browser and in `sbscore show` are the same set for the same score.

#### Unit
- Flag aggregation per bar and per score, including a score with no flags.

---

# v0.3 — the bespoke recogniser

> **Added, 2026-09-13.** oemer ships as v0.2's engine (V9–V14) and works, but it is
> unsatisfactory on two axes the maintainer cares about: recognition accuracy on real
> photos, and the RAM its full-page dual-U-Net segmentation demands (ADR-0025's CPU floor
> is a floor on *speed*, not on memory). This milestone explores replacing it with a
> **bespoke, staged pipeline we train ourselves** — layout detection, then per-crop
> recognisers — sized for CPU and low RAM. It is planning of record, not yet built.

The whole milestone rests on one insight and one constraint.

**The insight: we own a ground-truth data generator.** `engrave` + `layout` + `model` +
`music` render a `Score` to a pixel-exact page. Run that in reverse-gear as a *labeller*:
generate plausible lead sheets, render them, and read off both the detection boxes and the
note/chord sequences for free. Infinite, perfectly-labelled, in-domain training data — the
thing that normally makes "train our own OMR" a multi-year labelling slog. The synthetic→real
gap is bridged by domain randomisation (fonts, spacing, skew, blur, JPEG noise, paper
texture, shadow) and a small real control set, exactly as V12's harness already demands.

**The constraint: the engine boundary does not move.** A bespoke engine must emit the same
`OmrDocument` (`packages/model/src/omr.ts`), coordinates and all, so `mapOmrToScore`
(V11), the `WorkerClient` port, the job runner, the `/v1/imports` routes and both surfaces
are **untouched** — this is the ADR-0005 boundary doing its job. Where the bespoke output
genuinely cannot fit the schema, the schema is *evolved* (bump `OMR_SCHEMA_VERSION`), never
bypassed. oemer stays a selectable engine behind a new selection seam; the swap of the
**default** is *earned on the V12 harness* (ADR-0020), never decided by eye.

New ADRs this milestone writes: **ADR-0031** (the bespoke recogniser — the staged
architecture, the engine-selection seam, and the "conform to `OmrDocument`" rule); and a
note that `packages/synth` is a **deliberate exception** to the `model`/`layout`/`music`
"no Node APIs" invariant — it is a build-time data tool, not runtime, and must stay out of
every product bundle (`tests/arch` guards this, the way it guards the framework-free
packages today). Training code and the corpus never enter git or the shipped image; they
follow the `worker/fetch_weights.py` pattern — `.gitignore`d, produced/fetched on demand,
baked and checksummed into the worker image at build (ADR-0024).

**This milestone depends on V12.** You cannot earn an engine swap without the harness that
scores it. V12 is therefore a hard prerequisite for V15, not merely prior art.

## V15: The synthetic-data gate

> **Update, 2026-09-15 (scoping, pre-build).** Scoped with the maintainer after the oemer
> baseline was completed (KAN-1391 fixed, ADR-0032 now records all four degradation levels).
> Two build-plan items below are **already done**, ahead of schedule, so V15 shrinks to the
> parts that are actually new:
> - **Item 1 (`packages/synth`) exists** — built at V12 as the eval corpus generator
>   (`generateScore` + `@sibei/synth/imaging` render+degrade), the sanctioned ADR-0031 exception,
>   guarded out of every bundle by `tests/arch`. It emits **sequence** labels (the `Score`) but
>   **not yet pixel boxes / per-system crops** — its own `generate.ts` comment flags that as
>   "V15's extension". That gap is now **V15a**.
> - **Item 4 (the engine seam) exists** — `worker/sibei_omr/engines/{oemer,heuristic}`, chosen
>   by `--engine`/`$SIBEI_OMR_ENGINE` (V13c). The bespoke engine slots in beside them as a third
>   `engines/bespoke`; `oemer` stays the default until it wins the harness.
>
> **Decisions locked (maintainer, this session):**
> - **Stage-2a melody only** for the probe — no chords (V17), no layout detector (V16). Isolate
>   the most-solved sub-problem so a failure is a *data-strategy* failure, per ADR-0031.
> - **Training compute is always a RunPod GPU pod** (`worker/Dockerfile.gpu` + `tools/runpod/rp`,
>   ADR-0032). The CPU spot pod is thread-bound (~13 min/page, ADR-0032 finding 2) and unusable
>   for training.
> - **PyTorch → ONNX → onnxruntime CPU inference.** Training is GPU; the shipped engine is
>   CPU-first (ADR-0025) and rides the onnxruntime path the worker already loads for oemer, so no
>   new heavy runtime dependency. Weights baked + checksummed at build time (ADR-0024, the
>   `fetch_weights.py` pattern).
> - **Model is small on purpose** — no hard RAM ceiling, but the floor is "comfortable on an 8 GB
>   machine" (oemer's ~7 GB is the thing v0.3 exists to escape). Small also means **fast**, which
>   the gate now measures as a first-class axis (see the metrics note below and `docs/eval.md`).
>
> **The gate is now three-dimensional, not just accuracy** (ADR-0031 makes RAM half the point,
> and the maintainer added speed): the bespoke Stage-2a must beat oemer on **note accuracy**
> *and* run **materially faster at a materially smaller peak-RAM footprint**, on the CPU
> inference floor. The new speed/RAM metrics are defined in `docs/eval.md` ("Performance
> metrics"); the headline insight is that **speed is only meaningful measured thread-pinned** —
> oemer's wall-clock is distorted by onnxruntime thread over-subscription (ADR-0032 finding 2),
> so both engines are timed under a fixed thread budget or the comparison lies.
>
> **V15 decomposes into three sub-slices (stacked PRs, the V12/V13 pattern):**
> - **V15a — labels from the render stack (pure, no model, no compute).** Extend `@sibei/synth`
>   to emit, per staff system, its **pixel bounding box** in the rendered image and the ordered
>   note/rest **token sequence** inside it, and to cut `(system-crop image, token-sequence)`
>   training pairs. This is the load-bearing piece: `layout` already computes every position, so
>   this reads boxes off the layout rather than detecting them. Deterministic per seed. It is the
>   labeller the whole strategy rests on, and it ships before any model.
> - **V15b — train the Stage-2a CRNN+CTC (RunPod GPU).** A CNN over a fixed-height staff crop →
>   BiLSTM → CTC over a compact note/rest vocabulary (staff-position pitch × duration class,
>   kept to a few hundred symbols so CTC stays tractable). Domain randomisation from V15a's
>   generator. Train on GPU, export ONNX, bake + checksum the weights.
> - **V15c — wire `engines/bespoke` + score on the harness.** The bespoke engine takes system
>   crops (for the probe, reuse the **heuristic engine's OpenCV staff-finder** to get crops, since
>   the Stage-1 detector is V16 — this isolates 2a's recognition quality on real staff geometry),
>   runs the ONNX model, and emits a schema-valid `OmrDocument` (notes with bbox, pitch, duration).
>   Score noteF1 + sec/page + peak-RAM against oemer through the V12 harness.
>
> **V15c landed (2026-09-16), and V15's gate passes.** `worker/sibei_omr/engines/bespoke.py` loads the
> V15b model on onnxruntime CPU, reuses the heuristic staff-finder for staves+barlines, crops each
> system to the full-system box (matching the measured V15a proportions so train and inference crop
> alike), greedy-CTC-decodes, and derives each token's x from its **CTC column index**
> (`crop_left + (t+0.5)·cropW/T`) — the coordinate stage-3 rides on (Q71). The flat-semantic token
> carries pitch+duration, so the notehead bbox y is synthesised from the pitch on the detected staff and
> round-trips through the mapper's `pitchFromGeometry`; the model supplies the *sequence and horizontal
> order*, the geometry the *vertical*. The vocab manifest is exported deterministically
> (`pnpm export:v15c-vocab`); `model.onnx` + `vocab.json` are baked + checksummed (`bespoke_weights.py`,
> ADR-0024) and never committed. **Result (docs/eval.md):** clean synthetic noteF1 **0.868 vs 0.120**
> heuristic, at ~0.3 sec/page and ~176 MB peak RAM (oemer: ~7 GB, ~13 min). The synthetic→real transfer
> holds by eye on the maintainer's real photos (`worker/visualize_bespoke.py` →
> `out/v15c-real-preds/`); the real-photo bottleneck is the borrowed staff-finder (a phantom title
> "staff", a missed low-contrast staff) — exactly what V16's Stage-1 detector is for. Deferred by design:
> the accuracy-vs-oemer half of "earn the swap" (V16, needs oemer's baseline re-run on the widened
> corpus, KAN-1426), `peakMB` as an `OmrDocument.source` schema field (V16, with the swap decision), and
> the leading clef/key head the synthetic corpus does not yet render (a v0.3 generator gap). Triplets/
> tuplets remain out of scope: the generator emits none and the vocabulary has no tuplet class, though
> the runtime `Score` model already represents them (`Tuplet`), so it is a data+vocab+schema addition,
> not a model-architecture limit.

**Delivers:** the exit condition for ADR-0031, and the go/no-go on training our own

The riskiest unknown in the milestone, taken first, the way V1/V1b/V9 were. Everything
here rests on synthetic renders transferring to real photos. If a recogniser trained on
**synthetic data only** cannot read **real** staves within striking distance of oemer, the
"train our own" strategy collapses and the honest move is to stay on oemer (or go find real
labelled data). This slice buys that evidence before a line of the full pipeline is built.
The staff recogniser is chosen as the probe because monophonic single-staff recognition is
the most-solved sub-problem in the OMR literature — a small CRNN+CTC — so a failure here is
a failure of the *data strategy*, not of an over-ambitious model.

**Build plan**

1. `packages/synth` (NEW): a dev-only TypeScript tool reusing `model` + `music` + `layout`
   + `engrave`. Generate plausible lead sheets (random progressions over the chord grammar,
   melodies within range) → render → emit `(image, labels)` pairs, the labels carrying both
   pixel boxes and the ordered note/rest sequence. Node APIs allowed; asserted out of every
   product bundle by `tests/arch`.
2. Domain randomisation: music face, staff spacing, line weight, skew, blur, JPEG noise,
   paper texture, shadow — seeded and deterministic (a seed in, the same corpus out).
3. Train **one** stage — the staff recogniser (a system crop → note/rest sequence with
   x-positions) — on synthetic data only. Small, CPU-inference, low RAM.
4. The engine-selection seam in the worker: `sibei_omr/engines/{oemer,bespoke}/`,
   `oemer` moved intact from `recognize.py`, chosen by config, `oemer` the default.
5. **Gate:** run the staff recogniser through the **V12 harness** on the *real* control
   set against oemer's notes. Within a threshold recorded on ADR-0031 → proceed to V16.
   Not within it → stop; record whether the fix is more/better synthetic data or a return
   to oemer, on ADR-0031.

**Demo:** `make eval` scoring the bespoke staff recogniser beside oemer on the real control
set, note-level, with the synthetic→real gap visible — the same table V12 prints, one column
richer.

**Rests on assumptions:** the ground-truth-generator insight above, and Q41 (synthetic
ground truth is representative enough) — which is precisely what this slice exists to test.
If wrong, V16 and V17 do not happen and oemer stays the engine.

### Test plan

#### End-to-end
- The generator emits an image whose committed labels match the `Score` it rendered, box
  for box and note for note.
- `make eval` scores the bespoke staff recogniser on the real control set and prints it
  beside oemer.

#### Integration
- `packages/synth` imports no product-runtime code path that would pull it into a bundle,
  and the `no-Node` packages still import nothing from it — asserted by `tests/arch`.
- The engine seam returns a schema-valid `OmrDocument` for both `oemer` and `bespoke`.

#### Unit
- Each degradation is deterministic given its seed, so two corpus builds compare.
- Label extraction: a tie, a triplet and a two-chord bar produce the correct sequence.

---

## V16: The bespoke engine

**Delivers:** R5 (re-delivered at a lower RAM floor), and the earned default-engine swap
for notes and bars

V15 proved the data. This slice builds the rest of the pipeline and assembles a real engine
— the one that has to *beat oemer on the harness* to earn the default.

**Build plan**

1. Stage 1, the layout detector (`worker/sibei_omr/engines/bespoke/layout.py`): a small
   object detector (YOLO-nano class, CPU) trained on synthetic data to find staff systems,
   barlines, the chord band, and title/text blocks. Bars and four-bar phrases are *derived*
   from barlines + system breaks, not detected as objects (they are a layout convention,
   not a thing on the page).
2. Assembly (`assemble.py`): stage 1 + V15's staff recogniser → an `OmrDocument` carrying
   staves, noteheads, note groups, single barlines and rests with coordinates — the exact
   shape the schema already defines, so `mapOmrToScore` and the API are untouched.
3. Measure on the **V12 harness** against oemer: note accuracy, barline counts, percentage
   of metrically valid bars — **and peak RAM**, the axis this milestone exists to move.
4. Flip the default engine to `bespoke` **only if** it wins the harness; oemer stays
   selectable as the fallback. Record the numbers on ADR-0031.

**Demo:** import the same real photo twice, once per engine, and open both drafts beside the
`make eval` table — the bespoke draft is at least as good, at a fraction of the RAM.

**Rests on assumptions:** V15's gate passed. Q26 (multi-image imports still join in order,
unchanged from V11). Barline *type* is still not detected (ADR-0021), same as oemer.

### Test plan

#### End-to-end
- The bespoke engine imports a fixture photo to a draft whose bar count matches ground
  truth, opening/editing/exporting like any other score.
- An image with no detectable staff fails cleanly, same contract as V11.

#### Integration
- The bespoke engine's document validates against the `model` schema across the control
  set, and `mapOmrToScore` consumes it with no bespoke-specific branch.
- Peak RAM for a full-page import is recorded and is below oemer's on the same image.

#### Unit
- Bars/phrases are derived correctly from detected barlines + system breaks, including a
  section whose length is not a multiple of four.
- Coordinate sanity: every detected object lands inside the source image bounds.

> **V16 note (in progress — decomposes into stacked PRs, the V12/V13/V15 pattern):**
> - **V16a — page-level bbox labels from the render stack (pure, no model, no compute). LANDED.**
>   `packages/synth/src/page-boxes.ts` (`extractPageBoxes`) reads four object classes straight off
>   `layout()` — `staff` (the 5-line box at `staveY`, height = `staffHeight`; unit = height/4),
>   `barline` (one thin box per bar's right edge — the drawn dividers; a *bar* is the derived span
>   between two, never a box), `chordBand` (the full-width strip at `chordBaselineOffset` above the
>   staff, present only when the system has chords), and `title` (the header block, page 1 only, its
>   width estimated from glyph count since `measureText` is banned, ADR-0015). Boxes are in layout
>   units; the imaging half (`@sibei/synth/imaging` `renderDetectPages`/`renderPageBoxOverlay`) scales
>   them to a rendered page's pixels with the one `pxPerUnit` factor, exactly as V15a's crops did.
>   `pnpm dump:v16a` writes `pages/*.png` + `labels.jsonl` + `classes.json`; `pnpm proof:v16a` overlays
>   the boxes for eyeballing. This is the load-bearing piece and ships before any model, exactly as
>   V15a did. **Degradation in the dump is photometric only** (perspective forced to 0) so the boxes
>   stay pixel-aligned; the geometric half (perspective/rotation, which moves boxes) is on-the-fly,
>   label-safe augmentation in V16b, transforming image + boxes jointly — the same split V15 used.
> - **V16b — train the Stage-1 detector (RunPod GPU).** A small CPU/ONNX object detector (YOLO-nano
>   class, ADR-0031; a staff/barline heatmap hybrid held in reserve if box regression is data-hungry)
>   on the V16a corpus. Staff detection is the must-win; barline/band/title are easier. Keep it
>   ONNX-exportable — no dynamic-output ops (the V15b AdaptiveAvgPool lesson).
> - **V16c — `assemble.py`.** Stage-1 boxes → crop each system (the V15c full-system reconstruction) →
>   the **unchanged** V15c Stage-2a model → notes/rests; the borrowed heuristic staff-finder is
>   dropped. Chord band stays on oemer/PaddleOCR (bespoke chords are V17). Bars/phrases derived from
>   barline x + system breaks. One `OmrDocument`, coordinates in the source-image grid.
> - **V16d — score on the V12 harness** vs oemer, heuristic and the current (staff-finder-borrowing)
>   bespoke: noteF1 + validBars + sec/page + **peak RAM**, over the synthetic corpus and the real
>   samples; report whether Stage-1 kills the phantom-title-staff / missed-staff failures. `peakMB`
>   becomes an `OmrDocument.source` field here (the deferred v2→v3 bump).
> - **V16e — the swap decision.** Flip the default to `bespoke` **only if** it wins accuracy *and*
>   peak RAM (ADR-0031); else oemer stays. Record the numbers on ADR-0031. Needs oemer's baseline
>   re-run on the widened corpus (KAN-1426), on a pod since oemer OOMs on the 8 GB host.

---

## V17: Bespoke chords, and the swap

**Delivers:** R5 (completes the bespoke pipeline), R6 (the harness now scores a whole
bespoke import)

V13 built the chord pipeline on oemer's coordinates with PaddleOCR on the band (ADR-0027).
Because the bespoke engine emits the *same* coordinates, V13's stage-3 beat mapping and the
V5 grammar corrector ride on top unchanged — so this slice only replaces the OCR itself,
which is the remaining PaddleOCR RAM/accuracy cost, and closes the loop.

**Build plan**

1. Stage 2b (`engines/bespoke/chords.py`): a bespoke chord-band recogniser trained on
   synthetic chord renders (the generator already emits the chord sequence as a label),
   feeding the V5 grammar corrector (ADR-0011) — reusing the mechanism, not building a
   second one, exactly as V13 reused it for PaddleOCR.
2. Reuse V13's beat mapping (chord box → note/barline X-coordinate) verbatim; it depends on
   coordinates, which the bespoke engine already provides.
3. Non-chord band text and rehearsal letters handled as in V13 (Q56), unchanged.
4. Re-run `make eval` for chord accuracy; record the bespoke figure beside V13's PaddleOCR
   baseline on ADR-0031.

**Demo:** import a dense-chord chart through the fully-bespoke engine and see chords land on
the right beats with the uncertain ones flagged; `make eval` reports chord accuracy at or
above the PaddleOCR baseline, at lower RAM.

**Rests on assumptions:** V16 shipped. Q56 (chords above the staff), and Q71 transitively —
beat mapping still needs coordinates, which the bespoke engine supplies.

### Test plan

#### End-to-end
- A dense-chord fixture imports through the bespoke engine with chords at the correct beats,
  measured against ground truth.
- Non-chord band text survives as a flagged annotation, not a bogus chord.

#### Integration
- The grammar corrector improves bespoke chord accuracy over raw bespoke OCR, and the
  harness shows by how much.
- A whole bespoke import (notes + chords) scores on the harness at or above the oemer +
  PaddleOCR baseline, at lower peak RAM.

#### Unit
- Beat mapping on bespoke coordinates matches V13's behaviour on a shared fixture.

---

## Sequencing notes

- **V1, V1b and V9 are gates, not features.** Each has an explicit decision as its exit
  condition, and each precedes everything that depends on it.
- **V1b did not block V2.** The engraver spike and the write path touch nothing in
  common, so they could run in either order. ADR-0030 left the full replacement's
  position unscheduled until V1b returned a number; it returned one, and the replacement
  ran immediately as V1c and V1d, before V2. V1's `packages/draw` is gone from that
  point on — every slice after it engraves through `packages/engrave`.
- **V5 pays for itself twice.** The chord grammar built for user input is the OCR
  corrector in V13, which is why it is not deferred to v0.2.
- **V12 precedes V13** so the chord pipeline is measured as it is built. Reversing them
  would mean judging chord accuracy by eye.
- **v0.1 must carry v0.2's fields.** Confidence and review flags exist in the model from
  V1 even though nothing sets them until V11, because adding them later would mean
  migrating a library of hand-corrected charts (ADR-0026, ADR-0028).
- **V15 is a gate, and v0.3 depends on V12.** The bespoke recogniser earns its keep only on
  the evaluation harness, so V12 must exist first, and V15 is a hypothesis about synthetic
  data tested before V16/V17 are built on it — the same discipline as V1/V1b/V9.
- **The engine boundary is what makes v0.3 safe.** Every v0.3 slice conforms to
  `OmrDocument` (ADR-0005, ADR-0031), so `mapOmrToScore`, the runner and both surfaces never
  learn which engine ran. That is what lets oemer and the bespoke engine be compared on the
  harness and kept side by side, with the default swapped only when the numbers say so.
