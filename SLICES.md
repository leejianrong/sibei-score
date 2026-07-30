# sibei-score: Slices

Vertical increments. Each ends in something you can demonstrate, and no slice depends
on a later one. Requirements and shape parts are defined in `PLAN.md`; decisions in
`docs/adr/`.

Two milestones (ADR-0026). **v0.1** is the app without import — useful and shippable on
its own. **v0.2** adds import onto a foundation already proven by use.

Each milestone opens with its riskiest unknown. For v0.1 that is whether VexFlow can
draw a chart worth printing; for v0.2, and for the project as a whole, it is whether
oemer's pixel coordinates are reachable at all.

---

# v0.1 — the app without import

## V1: The render gate

**Delivers:** R3 (partial), and the exit condition for ADR-0014

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
2. `schema_version` inside the document, plus the migration runner on read that does not
   bump the score version (ADR-0028).
3. Op log table, and the op applier as the only writer (ADR-0003).
4. `/v1/` API: create, read, list, delete, and `POST /v1/scores/:id/ops` with
   `expectedVersion`. Stale writes return 409 with the current version.
5. Address resolver: `bar12.beat3`, `bar12.n3`, `note-17`, onsets only, errors listing
   the bar's real onsets (ADR-0007).
6. `batch` as a transactional op list.
7. CLI skeleton: `new`, `list`, `open`, `rm`, `note add|set|rm`, `rest`, `--json`
   everywhere, and distinct exit codes for conflict, bad address, and validation failure.
8. `sibei show`: the text projection (ADR-0009), printing the addresses it accepts.
9. Auth seam resolving `local`, plus the Origin check and the localhost bind before any
   browser client exists (ADR-0029).

**Demo:** author a short chart entirely from the CLI — `sibei new`, several `note add`
calls — then `sibei show` it and see the four-bar grid with addresses. Run the same
`note set` twice with a stale `--if-version` and watch the second fail with exit code 4
and the current version.

**Rests on assumptions:** Q77 (`schema_version`, forward-only migrations), Q79 (the op
arbitrates), Q78 (Origin check adequate locally).

### Test plan

#### End-to-end
- A chart authored entirely through CLI commands round-trips through `sibei show` with
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
- A document at `schema_version` N-1 is migrated on read, used, written back at N, and
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

**Build plan**

1. Wire `layout` and `draw` to scores loaded from the repository.
2. `GET /v1/scores/:id/export?format=pdf`, streaming from the `BlobStore` (ADR-0006).
   Exports are **generated on demand and cached** in the `BlobStore` keyed by
   `(score version, format, instrument)`, so a version bump invalidates them implicitly.
   This is what reconciles ADR-0016's "an instrument part stores nothing" with ADR-0006
   putting exported PDFs in the blob store: no *score variant* is ever stored, but a
   rendered artefact may be cached (Q81).
3. `sibei export --pdf`.
4. Page setup: A4 and Letter, A4 default, flowing to further pages (Q38).
5. Chart metadata in the PDF header — title, composer, key, style line — and `meta set`
   on both surfaces (Q37).
6. SVG snapshot regression tests wired into the suite.

**Demo:** `sibei new`, edit a few notes from the CLI, `sibei export --pdf`, open the
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
in a terminal run `sibei note set` on the same chart and watch the browser update without
a reload. The two surfaces visibly cannot disagree.

**Rests on assumptions:** none new.

### Test plan

#### End-to-end
- Editing a note in the browser changes the stored score, and `sibei show` reflects it.
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

**Build plan**

1. `music` package: chord grammar — parse and format root, quality, extensions,
   alterations, bass (ADR-0012). Unparseable text is retained verbatim and flagged.
2. `chord.set` and `chord.rm` ops, anchored to a beat within the bar (Q32).
3. Chord rendering above the staff through the draw adapter, using VexFlow's
   `ChordSymbol` for superscript extensions.
4. Chord editing in the browser with grammar validation as you type; `sibei chord set`.
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

**Build plan**

1. Enharmonic spelling engine: key-signature-driven, with per-object pins that survive
   transposition (ADR-0017).
2. `transpose` op — a mutation, logged and undoable (ADR-0016).
3. Instrument part generation as a render-time view: bb-trumpet (M2), bb-tenor (M9),
   eb-alto (M6), eb-bari (M13), f-horn (P5), each changing written octave and key
   signature.
4. Chord roots transpose with the written pitch on a part.
5. `--spell` on note and chord ops; `sibei transpose --to`; `sibei export --for
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
4. Structure panel in the browser; `sibei section set`, `sibei repeat set`.
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

**Build plan**

1. Undo and redo by replay of the op log minus the last operation (ADR-0003), exposed as
   `sibei undo` / `redo` and ctrl-Z, with an agent `batch` undoing as one unit.
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
6. `sibei import <file>...` and the library's import affordance.
7. Title and composer OCR-attempted, flagged low-confidence (Q37).

**Demo:** photograph a printed lead sheet, `sibei import` it, open it in the browser, and
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

**Delivers:** R6

**Build plan**

1. Split-pane score view: source image beside the rendered score, scrollable and
   zoomable (ADR-0019).
2. Confidence highlighting and invalid-bar shading on the score surface.
3. The `!` review flags in `sibei show`, so a human and an agent are pointed at the same
   places.
4. A prompt when a score has no sections, since layout silently depends on them and
   import never detects them (ADR-0021, ADR-0015).
5. `sibei reparse <id>` re-running the pipeline from the retained image.
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
- `sibei reparse` produces a fresh draft from the stored image without a new upload.

#### Integration
- Flags shown in the browser and in `sibei show` are the same set for the same score.

#### Unit
- Flag aggregation per bar and per score, including a score with no flags.

---

## Sequencing notes

- **V1, V1b and V9 are gates, not features.** Each has an explicit decision as its exit
  condition, and each precedes everything that depends on it.
- **V1b does not block V2.** The engraver spike and the write path touch nothing in
  common, so they can run in either order or in parallel. Only the full engraver
  replacement competes for time with the rest of v0.1, which is why ADR-0030 leaves its
  position unscheduled until V1b returns a number.
- **V5 pays for itself twice.** The chord grammar built for user input is the OCR
  corrector in V13, which is why it is not deferred to v0.2.
- **V12 precedes V13** so the chord pipeline is measured as it is built. Reversing them
  would mean judging chord accuracy by eye.
- **v0.1 must carry v0.2's fields.** Confidence and review flags exist in the model from
  V1 even though nothing sets them until V11, because adding them later would mean
  migrating a library of hand-corrected charts (ADR-0026, ADR-0028).
