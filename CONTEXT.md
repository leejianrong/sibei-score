# CONTEXT: sibei-score

The shared source of truth for this project. Two parts: a **glossary** fixing what
each term means, and a **decision register** listing every decision of record with a
pointer to its ADR.

Use these terms exactly, everywhere downstream. Where a word here differs from
casual usage, this file wins.

**The live plan is `PLAN.md`**, with the build handoff in `SLICES.md`. This file remains
the glossary and decision register that both cite — it is not superseded. Raw idea:
`REQS.md` (historical). Full question and answer audit trail: `QUESTIONS.md`. Decisions
in full: `docs/adr/`.

---

## Glossary

### The artefact

| Term | Meaning |
|---|---|
| **Lead sheet** / **chart** | A single staff carrying a melody, with chord symbols above it. The only kind of music this product handles. Used interchangeably. |
| **Score** | The stored object representing one chart: the musical content plus metadata, confidence flags, and its source image. What has an ID. |
| **Library** | The collection of scores, with a browse view — list, search, open, delete. |
| **Chart metadata** | Title, composer, key, and an optional style/tempo text line. OCR-attempted on import, editable from both surfaces. |

### Musical structure

| Term | Meaning |
|---|---|
| **Bar** | A measure. Numbered from 1. |
| **Bar 0** | The pickup bar, when present. Sits before bar 1 and consumes no four-bar slot. |
| **Onset** | The point at which a note begins. The only positions an address may name. |
| **Beat position** | Location within a bar, used to anchor chord symbols. `Ebm7@1, Bb7@3` means two chords in one bar. |
| **Section** | A named division of the form — A, B, bridge. Carries a **rehearsal letter**. |
| **Section boundary** | The edge of a section. Load-bearing for layout, not only notation: it forces a line break. |
| **Metric validity** | Whether a bar's durations sum to the time signature. A derived property, never an invariant. An invalid bar is stored and flagged. |
| **Rest** | A first-class object in the model, not an implied gap. Required for metric validity to mean anything. |

### Addressing

| Term | Meaning |
|---|---|
| **Address** | How an operation names its target. Three forms, all accepted: `bar12.beat3` (beat position), `bar12.n3` (ordinal — third note in bar 12), `note-17` (stable ID). |
| **Stable ID** | An app-owned identifier on every model object. Internal; does not survive MusicXML export. |
| **Onset-only rule** | An address naming a position that is not an onset is an error, and the error lists the real onsets in that bar. Never snapped to the nearest. |

### Chords

| Term | Meaning |
|---|---|
| **Chord symbol** | Text above the staff naming a harmony, anchored to a beat. `Cmaj7`, `F#m7b5`, `C7alt`, `Bb13#11`, `Ab/Eb`, `N.C.` |
| **Chord grammar** | The parser turning chord text into structure — root, quality, extensions, alterations, bass. Serves three jobs: OCR correction, input validation, and transposition. |
| **Grammar corrector** | The stage that snaps OCR output to the nearest legal chord symbol. |
| **Chord band** | The strip of image directly above a staff where chord symbols live. What stage 1 of the pipeline crops. |

### Pitch and transposition

| Term | Meaning |
|---|---|
| **Concert pitch** | Sounding pitch. What a score always stores. |
| **Written pitch** | How a transposing instrument's player reads it. Only ever produced at export time. |
| **Transpose** | Changing the chart's concert key. A **mutation** — logged and undoable. |
| **Part** | A written version of the score for a transposing instrument. A **view** — produced at export, never stored. `bb-trumpet`, `bb-tenor`, `eb-alto`, `eb-bari`, `f-horn`. |
| **Spelling** | Which enharmonic name a pitch or chord root is given. Key-signature-driven by default. |
| **Pin** | An explicit spelling override on one note or chord that survives transposition. |

### Editing and state

| Term | Meaning |
|---|---|
| **Operation** / **op** | One atomic change to a score. The only thing that mutates a score. |
| **Op log** | The append-only per-score sequence of operations. The system's spine: source of undo, ordering, and the audit trail. |
| **Op applier** | The single component that writes to the store. Nothing else does. |
| **Batch** | A list of operations applied in one transaction, and one undoable unit. |
| **Version** | A score's monotonic revision number. Every write states the version it expects. |
| **Stale write** | A write whose expected version is out of date. Rejected, with the current version returned so the client can retry. |

### Import

| Term | Meaning |
|---|---|
| **OMR** | Optical music recognition. |
| **Base OMR** | oemer, supplying notes, barlines and their pixel X-coordinates. |
| **Staff segmentation** | Pipeline stage 1: locate staves, crop the chord band above each. |
| **Beat mapping** | Pipeline stage 3: align recognised chord bounding boxes to note/barline X-coordinates. |
| **Detected** | Produced automatically by import. A deliberately narrower list than *supported*: notes, rests, ties, triplets, chord symbols, key and time signature, and single barlines only. |
| **Supported** | Present in the model, rendered and editable — but not necessarily detected. Double barlines, repeats, endings, sections and rehearsal letters are supported and hand-added. |
| **Draft** | What an import produces. Never a finished score. Correcting it is the primary import experience. |
| **Confidence flag** | A per-object marker that recognition was uncertain. Rendered as highlighting on screen and `!` in the text projection. |
| **Worker** | The Python process running the OMR pipeline. Never touches the database. |
| **Job** | An asynchronous unit of work — import is one. Submitted, then polled or subscribed to. |

### Surfaces

| Term | Meaning |
|---|---|
| **API** | The local HTTP API. The only writer, and the contract both clients share. |
| **UI** | The browser app — Svelte 5 + Vite. A client. Holds no authoritative state. |
| **Framework-free core** | The model, layout engine, chord grammar and operations are plain TypeScript with no framework dependency. The framework touches only the shell. |
| **CLI** | The host-side binary, `sibei`. A client, on equal footing with the UI. |
| **Text projection** | The compact bar-by-bar text rendering of a score for agents. Prints the addresses the CLI accepts. |
| **Parity** | The constraint that no capability exists on only one surface. Every feature is a core op with both a CLI verb and a UI control. |

### Rendering

| Term | Meaning |
|---|---|
| **Layout engine** | Ours. Turns the model into engine-independent positions, including the four-bar grid. Runs in the browser and on the server, same code. |
| **Draw adapter** | The seam. Turns layout positions into glyphs. `packages/engrave` is the only implementation; VexFlow was the first and was removed at V1d (ADR-0030). |
| **Engraver** | Our own draw adapter, `packages/engrave`. Draws every glyph from a SMuFL font's own outlines and published anchors, with no tuning constants and no font named in the code. Proved by V1b, built by V1c–V1d. |
| **Face** | Which SMuFL font a render uses: `normal` is Bravura, `jazz` is Petaluma, the Real Book look. A render-time argument, never a build-time constant. |
| **Four-bar grid** | Four bars per line, the jazz-chart convention. Default, broken by section boundaries. |
| **System** | One rendered line of music. Usually four bars. |
| **Nasty test chart** | The spike-gate fixture: four-bar grid, ties across barlines, triplets, a pickup, double barlines, `C7alt`, `F#m7b5`. |

### Storage and deployment

| Term | Meaning |
|---|---|
| **Store** | SQLite, behind a repository interface. Holds scores as JSON documents plus listing columns. |
| **BlobStore** | The interface over binary artefacts — source images, exported PDFs. Local directory now, S3-compatible later. |
| **Principal** / **owner** | Who a request belongs to. Always `local` in the MVP; the field and the seam exist from day one. |
| **Hosting-shaped** | The MVP's discipline: local-only deployment, built so hosting is a deployment change rather than a rewrite. |

### Evaluation

| Term | Meaning |
|---|---|
| **Synthetic corpus** | Evaluation images made by rendering known MusicXML and degrading it. Ground truth is free and exact. |
| **Tracking metrics** | Note accuracy, chord accuracy, percentage of metrically valid bars. Measured every run. |
| **Ship gate** | The release criterion: a 32-bar head correctable by hand in roughly two minutes. |

---

## Decision register

| id | decision | status | ADR |
|---|---|---|---|
| D1 | Local-first deployment, built hosting-shaped: eight constraints so hosting is a deployment change, not a rewrite | Accepted | [ADR-0001](docs/adr/0001-local-first-hosting-shaped.md) |
| D2 | Not building now: signup, billing, TLS, cloud storage, rate limiting, multi-user editing | Accepted | [ADR-0001](docs/adr/0001-local-first-hosting-shaped.md) |
| D3 | The server owns the score; the HTTP API is the only writer | Accepted | [ADR-0002](docs/adr/0002-server-owns-score-api-only-writer.md) |
| D4 | The CLI is a host-side binary over HTTP — not `docker exec`, not a dual-entry-point process | Accepted | [ADR-0002](docs/adr/0002-server-owns-score-api-only-writer.md) |
| D5 | The op log is the system's spine: undo, ordering, audit trail | Accepted | [ADR-0003](docs/adr/0003-op-log-and-optimistic-concurrency.md) |
| D6 | Optimistic concurrency via expected-version on every write; no locks, no last-write-wins | Accepted | [ADR-0003](docs/adr/0003-op-log-and-optimistic-concurrency.md) |
| D7 | Undo is shared across surfaces and per-score; a batch is one undoable unit | Accepted | [ADR-0003](docs/adr/0003-op-log-and-optimistic-concurrency.md) |
| D8 | Our own score model is the runtime truth; MusicXML is a codec at the edges only | Accepted | [ADR-0004](docs/adr/0004-own-model-musicxml-as-codec.md) |
| D9 | Node/TypeScript owns the API, store, model, ops, layout, PDF and chord grammar | Accepted | [ADR-0005](docs/adr/0005-node-owns-api-python-omr-worker.md) |
| D10 | Python is an OMR worker only; it never touches the database | Accepted | [ADR-0005](docs/adr/0005-node-owns-api-python-omr-worker.md) |
| D11 | SQLite store, score as a JSON document plus listing columns | Accepted | [ADR-0006](docs/adr/0006-sqlite-json-document-store.md) |
| D12 | Binary artefacts behind a `BlobStore` interface | Accepted | [ADR-0006](docs/adr/0006-sqlite-json-document-store.md) |
| D13 | CLI addresses by musical position; the model carries stable IDs; both accepted | Accepted | [ADR-0007](docs/adr/0007-position-addressing-stable-ids.md) |
| D14 | Onset-only addressing — a miss errors with the real onsets listed, never snaps | Accepted | [ADR-0007](docs/adr/0007-position-addressing-stable-ids.md) |
| D15 | A pickup is bar 0; bar 1 is the first full bar | Accepted | [ADR-0007](docs/adr/0007-position-addressing-stable-ids.md) |
| D16 | Imperative CLI verbs plus a `batch` wrapper; no document-patch endpoint | Accepted | [ADR-0008](docs/adr/0008-imperative-cli-verbs-plus-batch.md) |
| D17 | `--json` on every command; distinct exit codes for conflict, bad address, validation failure | Accepted | [ADR-0008](docs/adr/0008-imperative-cli-verbs-plus-batch.md) |
| D18 | A compact text projection is a first-class read surface, and it prints the addresses the CLI accepts | Accepted | [ADR-0009](docs/adr/0009-agent-text-projection.md) |
| D19 | Three-stage hybrid OMR: staff segmentation → chord-band text recognition → beat mapping | Accepted | [ADR-0010](docs/adr/0010-hybrid-omr-pipeline-oemer.md) |
| D20 | oemer is the base OMR engine — MIT licence, one Python process, and it yields pixel coordinates | Accepted | [ADR-0010](docs/adr/0010-hybrid-omr-pipeline-oemer.md) |
| D21 | Entirely local pipeline; no vision-model path, opt-in or otherwise; CPU-only required | Accepted | [ADR-0010](docs/adr/0010-hybrid-omr-pipeline-oemer.md) |
| D22 | Chord recognition staged: off-the-shelf OCR plus a grammar corrector first; fine-tuning is stage 2, kept only if the harness moves | Accepted | [ADR-0011](docs/adr/0011-staged-chord-recognition.md) |
| D23 | Open chord grammar parsing to structure; unparseable text kept verbatim and flagged | Accepted | [ADR-0012](docs/adr/0012-open-chord-grammar.md) |
| D24 | Metrically invalid bars are stored and flagged, never rejected or auto-repaired | Accepted | [ADR-0013](docs/adr/0013-store-and-flag-invalid-rhythm.md) |
| D25 | ~~VexFlow~~ **our own engraver** behind an explicit draw seam. The gate ran and went the other way; the seam is what made the swap cheap | Superseded | [ADR-0014](docs/adr/0014-vexflow-behind-draw-seam.md), [ADR-0030](docs/adr/0030-own-the-engraver.md) |
| D26 | PDF via server-side layout → SVG → PDF; deterministic, regression-tested on SVG snapshots. No headless DOM since the engraver replaced VexFlow | Accepted | [ADR-0014](docs/adr/0014-vexflow-behind-draw-seam.md), [ADR-0030](docs/adr/0030-own-the-engraver.md) |
| D27 | The layout engine is ours and engine-independent, shared verbatim by browser and server | Accepted | [ADR-0015](docs/adr/0015-four-bar-layout-engine.md) |
| D28 | Four bars per line by default; a section boundary breaks the line | Accepted | [ADR-0015](docs/adr/0015-four-bar-layout-engine.md) |
| D29 | The score always stores concert pitch | Accepted | [ADR-0016](docs/adr/0016-transposition-mutation-vs-part-view.md) |
| D30 | Concert-key transposition is a mutation; an instrument part is a render-time view | Accepted | [ADR-0016](docs/adr/0016-transposition-mutation-vs-part-view.md) |
| D31 | Parts for Bb, Eb and F instruments, with correct written octave and key signature | Accepted | [ADR-0016](docs/adr/0016-transposition-mutation-vs-part-view.md) |
| D32 | Enharmonic spelling follows the destination key signature, with a per-object pin as escape hatch | Accepted | [ADR-0017](docs/adr/0017-enharmonic-spelling-policy.md) |
| D33 | Import is raster-only through one pipeline; no digital-PDF vector/text fast path | Accepted | [ADR-0018](docs/adr/0018-import-printed-raster-only.md) |
| D34 | Printed and engraved charts only; handwritten manuscript out of scope | Accepted | [ADR-0018](docs/adr/0018-import-printed-raster-only.md) |
| D35 | One chart may come from several images; automatic preprocessing only, no crop UI; `sibei new` creates a blank chart | Accepted | [ADR-0018](docs/adr/0018-import-printed-raster-only.md) |
| D36 | Every parse is a draft; side-by-side source image and score with confidence highlighting is the primary import experience | Accepted | [ADR-0019](docs/adr/0019-parse-is-a-draft.md) |
| D37 | The source image is kept permanently, enabling re-parse by a better engine later | Accepted | [ADR-0019](docs/adr/0019-parse-is-a-draft.md) |
| D38 | Evaluation corpus is primarily synthetic (rendered MusicXML, degraded), plus a small real-photo control set | Accepted | [ADR-0020](docs/adr/0020-omr-evaluation-strategy.md) |
| D39 | Tracking metrics are note accuracy, chord accuracy and metric-validity rate; the ship gate is a human-time target | Accepted | [ADR-0020](docs/adr/0020-omr-evaluation-strategy.md) |
| D40 | Notation coverage: sections, rehearsal letters, repeats with endings, pickup, ties, triplets, double barlines, explicit rests, one time signature | Accepted | [ADR-0021](docs/adr/0021-notation-coverage-boundary.md) |
| D41 | Out of scope: D.S., D.C., segno, coda, Fine, mid-chart time signature changes | Accepted | [ADR-0021](docs/adr/0021-notation-coverage-boundary.md) |
| D42 | A4 and Letter, A4 default; charts flow onto further pages | Accepted | [ADR-0021](docs/adr/0021-notation-coverage-boundary.md) |
| D43 | Both surfaces are equal citizens (parity), and the product is a personal tool for now | Accepted | — (`QUESTIONS.md` Q18) |
| D44 | No local authentication; API binds to localhost; the auth seam resolves every request to `local` | Accepted | [ADR-0001](docs/adr/0001-local-first-hosting-shaped.md) |
| D45 | Two containers via compose: `api` (Node) and `worker` (Python); import is a job | Accepted | [ADR-0005](docs/adr/0005-node-owns-api-python-omr-worker.md) |
| D46 | An import is one operation carrying the whole document; score creation lives inside the log | Accepted | [ADR-0003](docs/adr/0003-op-log-and-optimistic-concurrency.md) |
| D47 | Forward operations only; undo replays the log minus the last op. No inverse operations | Accepted | [ADR-0003](docs/adr/0003-op-log-and-optimistic-concurrency.md) |
| D48 | Barline *type* is not detected. Import yields single barlines only; double barlines, repeats, endings and sections are hand-added | Accepted | [ADR-0021](docs/adr/0021-notation-coverage-boundary.md) |
| D49 | Consequence of D48: a fresh import lays out on a plain four-bar grid until sections are added, so the correction view prompts when a score has no sections | Accepted | [ADR-0019](docs/adr/0019-parse-is-a-draft.md), [ADR-0015](docs/adr/0015-four-bar-layout-engine.md) |
| D51 | Svelte 5 + Vite for the UI shell; the model, layout, grammar and ops stay framework-free plain TypeScript | Accepted | [ADR-0022](docs/adr/0022-svelte-shell-and-api-versioning.md) |
| D52 | `/v1/` in the API path from the first commit; breaking changes allowed within v1 until hosting, then frozen and additive-only | Accepted | [ADR-0022](docs/adr/0022-svelte-shell-and-api-versioning.md) |
| D53 | oemer is used as a **library** to reach note and barline coordinates, with a vendored fork as the contingency; proved by a spike before any app code | Accepted | [ADR-0023](docs/adr/0023-oemer-as-library-with-fork-contingency.md) |
| D54 | All model weights are baked into the image at build time with pinned checksums; offline operation is a tested property | Accepted | [ADR-0024](docs/adr/0024-model-weights-baked-at-build-time.md) |
| D55 | CPU-only is the hard floor; GPU is an opt-in compose profile that changes speed, never behaviour | Accepted | [ADR-0025](docs/adr/0025-cpu-only-floor-gpu-profile.md) |
| D56 | Ship in two milestones: v0.1 is the app without import, v0.2 adds import | Accepted | [ADR-0026](docs/adr/0026-two-milestones-v01-without-import.md) |
| D57 | PaddleOCR for the chord band (chosen on its fine-tuning pipeline); `homr` rejected on AGPL, no coordinates, and no chord support | Accepted | [ADR-0027](docs/adr/0027-paddleocr-and-dependency-register.md) |
| D58 | Every runtime dependency is permissively licensed and runs offline — register of record in the ADR | Accepted | [ADR-0027](docs/adr/0027-paddleocr-and-dependency-register.md) |
| D59 | Score documents carry `schema_version`; forward-only migrations on read, and a newer version than the code is a hard error | Accepted | [ADR-0028](docs/adr/0028-score-document-schema-versioning.md) |
| D60 | Local threat model: 127.0.0.1 bind, Origin validation, no wildcard CORS, uploads validated by decoding | Accepted | [ADR-0029](docs/adr/0029-local-http-threat-model.md) |
| D61 | The core operation arbitrates when the two surfaces conflict — neither surface owns anything | Accepted | — (`QUESTIONS.md` Q79) |
| D62 | Exports are cached in the `BlobStore` keyed by score version; no score *variant* is ever stored | Accepted | — (`QUESTIONS.md` Q81, `PLAN.md`) |
| D50 | `REQS.md` is kept as a historical record with inline supersession markers; `CONTEXT.md` wins where they differ | Accepted | — (`QUESTIONS.md` Q70) |
| D63 | The V1 gate ran and decided: **own the engraver**. Done at V1d — `packages/draw` and the `vexflow` dependency are gone, and `packages/engrave` is what ships | Accepted | [ADR-0030](docs/adr/0030-own-the-engraver.md) |
| D64 | The engraver was sequenced spike-first: V1b proved the approach and produced the estimate, and the full replacement followed as V1c–V1d, before V2 | Accepted | [ADR-0030](docs/adr/0030-own-the-engraver.md) |
| D66 | The engraved face is the reader's choice per render — Bravura (`normal`) or Petaluma (`jazz`) — so no font is named in the engraver's code | Accepted | [ADR-0030](docs/adr/0030-own-the-engraver.md), [ADR-0027](docs/adr/0027-paddleocr-and-dependency-register.md) |
| D65 | The project is MIT licensed | Accepted | `LICENSE` |

### Not yet decided

| id | question | where |
|---|---|---|
| — | Synthetic chord-symbol dataset design (fonts, grammar coverage, degradations) | `QUESTIONS.md` Q54 — deferred to stage 2 |
