# sibei-score: Plan

Status: draft · Milestones: **v0.1** (app without import) and **v0.2** (import)

The live planning document. Terms are defined in `CONTEXT.md`, which also holds the
decision register; this file cites ADRs rather than restating them. Build handoff is
`SLICES.md`. The full question and answer audit trail is `QUESTIONS.md`. `REQS.md` is
the historical idea capture and is superseded where they differ.

## Problem

A jazz musician's book exists on paper. Photographing a chart gives you an image, not
something you can transpose for a different horn, fix a wrong chord in, or print
cleanly for a stand. General notation software can do all of that, but it is built for
orchestral scores: the cost of entry is a week of learning a tool whose feature set is
mostly irrelevant to a single staff with chord symbols over it. Nothing is specialised
for the one document jazz actually runs on.

The second gap is automation. Notation apps are GUI-shaped, so an agent cannot act on a
chart. There is no way to say "transpose everything in this folder to concert Bb and
export parts" and have something do it.

## Solution

A local app for exactly one document type: the jazz lead sheet. Point it at a photo of
a chart and get an editable score with the melody, the chord symbols, and the
structural marks. The parse will be wrong in places, so the app is built around
correcting it — the original photo sits beside the rendered score, and everything the
recogniser was unsure about is flagged so you know where to look. Fix it, then export a
clean PDF laid out four bars to a line the way a chart should be.

Everything is reachable two ways. A browser UI for a human, and a CLI for a human or an
agent, on genuinely equal footing — same operations, same guarantees, and never a state
where the two disagree about the score. Transpose the chart to a new concert key, or
generate a Bb-trumpet part from it, from either surface.

## Users and actors

**Primary, jointly:** a musician editing in the browser, and an agent driving the CLI.
Parity between them is a design constraint, not a nice-to-have (Q18).

**When they conflict:** neither wins, because neither owns anything. The **core
operation** is the arbiter — a capability is defined as an op first, and if it cannot be
expressed as an op with both a CLI verb and a UI control, it is not built (Q79).

**Scale:** one person, one machine, one library. Not multi-user, not collaborative. A
hosted multi-user service is an intended future (ADR-0001) but no part of either
milestone.

## Scope

### In — v0.1 (the app without import)

- Create a blank chart and edit it: notes, rests, pitch, duration, position, key
  signature, time signature, accidentals
- Chord symbols anchored to beats, parsed to structure (ADR-0012)
- Structure: sections with rehearsal letters, repeat barlines with 1st/2nd endings,
  pickup bars, double barlines, ties, triplet brackets
- Transpose to a new concert key; generate Bb, Eb and F instrument parts (ADR-0016)
- Export PDF laid out four bars per line, and MusicXML
- A library of charts: list, search, open, delete
- Undo and redo, shared across both surfaces (ADR-0003)
- Full CLI parity, JSON output, meaningful exit codes, and the agent text projection
  (ADR-0008, ADR-0009)

### In — v0.2 (import)

- Import a photo, scan or rasterised PDF of a printed chart (ADR-0018)
- The three-stage pipeline: staff segmentation, chord-band recognition, beat mapping
  (ADR-0010)
- Correction experience: side-by-side image and score, confidence and review flags
  (ADR-0019)
- Evaluation harness with a synthetic corpus and the human-time ship gate (ADR-0020)
- Re-parse a stored chart from its retained source image

### Out, and why

- **Playback, audio, MIDI** — a different product. `REQS.md` excluded it and nothing
  since has argued for it.
- **Articulations, dynamics, ornaments, grace notes, lyrics** — not what a lead sheet
  carries.
- **Multi-staff, multi-part, piano, drum notation** — the single-staff assumption is
  load-bearing in the layout engine, not incidental.
- **D.S., D.C., segno, coda, Fine** — poorly recognised, high correction burden, and
  purely navigational: the music is fully represented without them (ADR-0021).
- **Mid-chart time signature changes** — one signature per chart in both milestones.
- **Handwritten manuscript** — oemer is not trained for it and it needs its own models
  and corpus (ADR-0018).
- **Digital-PDF vector and embedded-text extraction** — would give much better accuracy
  on that input class, but it is a genuinely second pipeline (ADR-0018).
- **Accounts, hosting, TLS, billing, quotas, collaboration** — deliberately deferred,
  with the architecture shaped so they are additive (ADR-0001).
- **Fine-tuned chord OCR** — staged to after the evaluation harness can prove it helps
  (ADR-0011).
- **Barline *type* detection** — import yields single barlines only; double barlines,
  repeats and sections are hand-added (ADR-0021).

## Requirements

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | A jazz lead sheet can be edited, transposed and exported as a clean four-bars-per-line PDF, from either a browser or a CLI, with the two never disagreeing | Core goal |
| R1 | Every capability is reachable from both surfaces, with machine-readable output and meaningful exit codes on the CLI | Must-have |
| R2 | An agent can read a chart cheaply enough to reason about it without loading MusicXML | Must-have |
| R3 | Notation coverage is sufficient to print a chart a musician can read off a stand | Must-have |
| R4 | Transposition covers both concert-key change and instrument-part generation, with reader-appropriate enharmonic spelling | Must-have |
| R5 | A photo of a printed chart becomes an editable draft score | Must-have (v0.2) |
| R6 | A wrong parse is correctable in roughly two minutes for a 32-bar head | Must-have (v0.2) |
| R7 | The whole app runs locally, offline, on CPU alone, from a container — true of v0.1 as a single container, and of v0.2 with the worker | Must-have |
| R8 | Hosting the app later is a deployment change, not a rewrite | Must-have |
| R9 | Concurrent edits from a human and an agent cannot silently lose work | Must-have |

## Shape

The mechanisms being built. Each is a thing you build, not an intention.

| Part | Mechanism | ADR |
|------|-----------|-----|
| P1 | Score model: single-voice melody with explicit rests, beat-anchored chords, sections, spelling pins, confidence and review flags. Plain framework-free TypeScript | ADR-0004, ADR-0022 |
| P2 | Single write path: `POST /v1/scores/:id/ops` → validate → apply → append to op log → persist → broadcast. The op applier is the only writer | ADR-0002, ADR-0003 |
| P3 | Optimistic concurrency: every write carries an expected version; a stale write returns 409 with the current version | ADR-0003 |
| P4 | Undo by replay: replay the op log minus the last operation. No inverse operations | ADR-0003 |
| P5 | Store: SQLite, score as a JSON document with `schema_version`, plus listing columns, behind a repository interface. Forward-only migrations on read | ADR-0006, ADR-0028 |
| P6 | `BlobStore` interface over source images and cached exports, keyed by score version so a bump invalidates | ADR-0006, Q81 |
| P7 | Address resolver: `bar12.beat3` / `bar12.n3` / `note-17` → object. Onsets only; a miss errors with the bar's real onsets listed | ADR-0007 |
| P8 | Chord grammar: parse and format root / quality / extensions / alterations / bass. Also the OCR corrector and the input validator | ADR-0012 |
| P9 | Layout engine: model → engine-independent positions. Four-bar grid, broken at section boundaries; pickup outside the grid | ADR-0015 |
| P10 | Draw adapter: layout positions → glyphs. VexFlow implementation, replaceable | ADR-0014 |
| P11 | PDF path: server-side VexFlow → SVG → PDF, pinned metadata for reproducibility | ADR-0014 |
| P12 | Transposition engine: concert-key change as an op; instrument part as a render-time view. Key-signature-driven spelling with per-object pins | ADR-0016, ADR-0017 |
| P13 | MusicXML codec, import and export only, never the runtime truth | ADR-0004 |
| P14 | Text projection: four-bar grid plus per-bar melody with inline addresses and `!` review flags | ADR-0009 |
| P15 | Auth seam: middleware resolving a principal, returning `local`. Origin validation and upload decoding at the boundary | ADR-0001, ADR-0029 |
| P16 | Job runner: submit → run → poll or subscribe. Failure is a `failed` job with a diagnostic, retryable, committing nothing | ADR-0001, Q80 |
| P17 | OMR worker (Python): oemer as a library, exposing notes, barlines and coordinates | ADR-0010, ADR-0023 |
| P18 | Chord-band pipeline: staff segmentation → crop → PaddleOCR → grammar corrector → beat mapping | ADR-0010, ADR-0011, ADR-0027 |
| P19 | Import as one operation carrying the whole parsed document | ADR-0003 |
| P20 | Evaluation harness: MusicXML → render → degrade generator, plus note, chord and metric-validity metrics | ADR-0020 |
| P21 | Container topology: `api` (Node) and `worker` (Python) via compose, weights baked at build time, opt-in GPU profile | ADR-0024, ADR-0025, Q44 |

## Affordances

**UI** — Svelte 5 shell; the score surface is SVG from P9/P10, not components.

| Affordance | Place | Wires to |
|------------|-------|----------|
| Chart list with search | Library view | `GET /v1/scores` |
| New blank chart | Library view | `score.create` op |
| Score canvas, click to select a note | Score view | P9 layout, hit-tested against SVG |
| Note editor: pitch, duration, accidental, spelling pin | Score view, inspector | `note.set` op |
| Chord editor with grammar validation as you type | Score view, above the staff | P8, `chord.set` op |
| Key and time signature, title, composer, style | Score view, header panel | `meta.set` op |
| Section and repeat marks | Score view, structure panel | `section.set`, `repeat.set` ops |
| Transpose dialog | Score view toolbar | `transpose` op |
| Export: PDF, MusicXML, instrument part | Score view toolbar | `GET /v1/scores/:id/export` |
| Undo and redo, ctrl-Z | Global | `POST /v1/scores/:id/undo` |
| Source image beside the score, zoomable | Score view, split pane (v0.2) | P6 blob fetch |
| Review flags on uncertain objects, and a no-sections prompt | Score view (v0.2) | model flags from P17/P18 |
| Import progress | Library view (v0.2) | P16 job subscription |

**Non-UI**

| Affordance | Kind | Wires to |
|------------|------|----------|
| `sibei new` / `list` / `open` / `rm` | CLI command | scores API |
| `sibei show [--json]` | CLI command | P14 text projection |
| `sibei note add\|set\|rm`, `rest`, `tie`, `tuplet` | CLI command | ops API |
| `sibei chord set\|rm` | CLI command | P8, ops API |
| `sibei section set`, `repeat set`, `meta set` | CLI command | ops API |
| `sibei transpose --to` | CLI command | P12 |
| `sibei export --pdf\|--musicxml [--for <instrument>]` | CLI command | P11, P12, P13 |
| `sibei batch` | CLI command | transactional op list |
| `sibei undo` / `redo` | CLI command | P4 |
| `sibei import <file>...` (v0.2) | CLI command | P16 job, then polls |
| `sibei reparse <id>` (v0.2) | CLI command | P6 stored image → P16 |
| Op applier | Handler | the only writer, P2 |
| Score repository | Store | P5 |
| Migration runner | Store | P5, on read |
| Job runner | Service | P16 |
| OMR worker | Service (Python container) | P17, P18 |
| Eval harness | Command | P20 |

## Implementation decisions

**Module boundaries.** Four framework-free TypeScript packages — `model` (types,
validation, metric validity), `music` (chord grammar, transposition, enharmonic
spelling), `layout` (positions, four-bar grid), `codec` (MusicXML) — plus `api` (HTTP,
store, ops, jobs), `draw` (VexFlow adapter), `cli`, and `ui` (Svelte). The first four
must not import anything framework-specific or Node-specific, because `layout` and
`model` run in the browser as well as the server (ADR-0005, ADR-0022). This is asserted
by a dependency test, not by discipline.

**The op contract.** An operation is `{type, target?, payload, expectedVersion}`. The
applier validates against the model, applies, appends, and returns
`{version, changed[]}`. Operations are versioned independently of the document schema,
and old operation payloads must stay interpretable forever because undo replays them
(ADR-0028). Everything that mutates a score is an op — including import (P19) and
including transposition, which is why score creation lives inside the log rather than
beside it.

**Address resolution** happens server-side, so both surfaces get identical semantics
and identical error messages. The resolver returns the bar's real onsets on a miss,
which is what makes the strict rule usable rather than merely safe (ADR-0007).

**The layout contract** is the seam that matters most for the renderer's replaceability:
`layout(score, pageSpec) → {systems: [{bars: [{x, width, glyphs: [{kind, x, y, ...}]}]}]}`.
The draw adapter consumes only that. Nothing in `layout` may reference VexFlow, and
nothing in `draw` may make layout decisions (ADR-0014).

**Worker contract.** The worker receives image bytes and returns a JSON document
conforming to a schema owned by the TypeScript `model` package. It never touches the
database, and nothing outside it knows oemer exists. A schema-conformance test runs on
the Python side so a contract break fails in the worker's own test suite rather than at
integration time (ADR-0005, ADR-0023).

**Chord grammar placement.** In `music`, not in the worker, so one implementation serves
OCR correction, user input validation, and chord-root transposition (ADR-0011).

**Reproducible export.** PDF metadata is pinned to fixed values so a given score always
produces identical bytes. Regression tests snapshot the SVG rather than the PDF, since
PDF structure varies with library versions in ways that are noise (Q39).

**Export caching.** An instrument part is a render-time view and no score variant is ever
stored (ADR-0016), but the rendered artefact is cached in the `BlobStore` keyed by
`(score version, format, instrument)`. A version bump invalidates the cache implicitly,
so there is no invalidation logic to get wrong (Q81).

**Offline is a tested property**, not a claim: weights are baked at build time with
pinned checksums, and an import runs in a container with networking disabled as part of
the suite (ADR-0024).

## Testing approach

The highest-value seam is the **HTTP API**, because both surfaces go through it and it is
where "the UI and CLI cannot disagree" is either true or false. Most behavioural tests
belong there, driving real ops against a real SQLite store.

Three properties get asserted directly rather than being left to reasoning:

1. The only writes to the store come from the op applier.
2. Replaying a score's op log from empty reproduces the stored document exactly.
3. `model`, `music`, `layout` and `codec` import nothing framework- or Node-specific.

Below the API: unit tests where the logic is genuinely algorithmic and the cases are
enumerable — chord grammar parsing and formatting, enharmonic spelling, transposition
intervals including written octave, metric validity, address resolution, the four-bar
grid with section breaks and pickups, and schema migrations carrying a fixture forward
through every version.

Rendering is tested by SVG snapshot on a small set of fixture charts, with the nasty
chart as the fixture of record. Snapshots catch unintended layout change; they do not
judge whether the engraving looks good, which is what the ADR-0014 spike gate is for and
which only a person can do.

For v0.2, OMR accuracy is not a pass/fail test but a **tracked metric** from the
evaluation harness, reported per run. The release gate is the human-time target
(ADR-0020). Treating a model's accuracy as a unit test assertion would make the suite
fail for reasons unrelated to the change under test.

## Assumed defaults

Taken on your behalf. Each is one row in `QUESTIONS.md` and each is correctable.

| ID | Assumed | Cost if wrong |
|----|---------|---------------|
| Q71 | oemer's coordinates are reachable by using it as a library | Highest in the plan. Stage 3 cannot be built as designed; fallback is vendoring a fork. V9 exists to find out first |
| Q27 | Preprocessing is automatic only — no crop UI | If real photos need manual correction, import quality has no user recourse and V13 grows a cropper |
| Q26 | One chart may come from several images; one photo containing two tunes is unsupported | Rework in the import job's input handling only |
| Q44 | Two containers, `api` and `worker`, worker never touches the DB | Contained; the topology is a compose file and an HTTP call |
| Q37 | Title and composer are OCR-attempted from the image | Cosmetic. They are editable regardless |
| Q38 | A4 and Letter, A4 default, charts flow to more pages | Small layout change |
| Q39 | Deterministic export, SVG snapshots not PDF bytes | Only affects how the regression test is written |
| Q28 | Partial score with flagged gaps is the normal failure mode; hard error only when no staff is found | Import error handling, contained to V11 |
| Q16 | Hand-correcting ties and triplets is acceptable | If unacceptable, import needs a specialist stage like the chord band got |
| Q34 | One time signature per chart | Model and layout change, moderate |
| Q35 | Explicit rest objects | Cheap now; expensive after a library exists |
| Q46 / Q78 | No auth; localhost bind, Origin check, upload decoding | Adequate locally; says nothing about hosted |
| Q49 | The CLI is the same binary pointed at a base URL with a token | Contained to CLI config |
| Q56 | Non-chord text in the chord band is kept as a flagged annotation; chords outside the band are missed | Affects import fidelity on unusual charts |
| Q77 | `schema_version` with forward-only migrations on read | Near-zero now, painful once charts exist |
| Q79 | The core op arbitrates when the surfaces disagree | Shapes how every feature is designed |
| Q80 | A failed import commits nothing and is retryable | Contained to the job runner |
| Q74 | PaddleOCR over EasyOCR | Redoes stage 2's fine-tuning work if reversed later |
| Q81 | Exports are cached in the blob store keyed by score version | Trivial — delete the cache and generate every time |

## Open risks

| Risk | Revealed by |
|------|-------------|
| oemer's internal coordinates are private, unstable, or absent, breaking stage 3 as designed | **V9**, the first slice of v0.2, before anything is built on it |
| VexFlow's output is not good enough for a chart on a stand | **V1**, the first slice of v0.1 — the spike gate is the slice's exit condition |
| CPU-only import is slow enough that the parse → fix → re-parse loop is impractical | **V9**, which measures wall-clock as a deliverable |
| Off-the-shelf OCR on chord symbols is poor enough that stage 2 fine-tuning becomes mandatory rather than optional | **V12** and **V13**, since the harness lands before the chord pipeline |
| Automatic preprocessing cannot cope with real phone photos, and there is no crop UI | **V12**'s real-photo control set, deliberately including bad photos |
| Because sections are not detected, every import needs structural correction before it lays out correctly | **V13**, and it is why the no-sections prompt is in that slice |
| oemer is unmaintained since October 2023 | Already known. Mitigated by MIT licensing and worker isolation |
