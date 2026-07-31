# Questions

Seeded from the initial idea capture in `REQS.md`, before step A of the planning
process. `/grill-with-docs` adds to this file and records answers here.

Answer format: add an `A:` line under a question. Leave unanswered ones alone.

Priorities: **P0** blocks the architecture · **P1** shapes a stage · **P2** can
take a sensible default (marked `ASSUMED` with the default stated, correct it if
wrong).

Status per question: `OPEN` · `ANSWERED` · `DEFERRED` · `ASSUMED`.

## Already settled

Recorded here so they don't get reopened later.

- The UI is a browser app served from a Docker container, running locally only.
- The frontend is React or Svelte with Vite.
  - **Amended (Q65):** Svelte 5 + Vite. The choice did *not* fall out of the rendering
    library as originally assumed — VexFlow is framework-agnostic.
- Double barlines are in scope for the MVP, detected on import and rendered.
  - **Amended (Q69):** double barlines are supported, rendered and editable but **not
    detected**. Barline classification is a weak spot of the chosen OMR engine, so the
    user adds them.
- Ties and triplet brackets are in scope, detected and rendered.
  - Still true. Both are detected, and both carry confidence flags because they are
    among the harder marks for OMR (Q16).

## Product and scope

- **Q1.** `P0` `ANSWERED` Do the CLI and the browser share state through a score file on disk that
  the UI watches, or does the CLI call an API on the same server process? This
  decides whether concurrent edits from an agent and a human can conflict.
  - A: No option picked. Volunteered a hard new constraint instead: *"eventually I
    want to be able to transition this to a web app (like a service that people can
    use on the web)."* This rules out the file-watch and `docker exec` designs
    (neither survives multi-user hosting) and points at the server-owns-the-score
    design. Refined in **Q48**–**Q49**.
  - A (resolved): **Neither of the original options — the server owns the score and the
    HTTP API is the only writer.** No file on disk for the UI to watch, no second write
    path. Concurrent edits from an agent and a human cannot diverge because there is only
    one writer; they can only *conflict*, which the expected-version check (Q21) turns
    into a retry rather than a divergence.
- **Q2.** `P0` `ANSWERED` How does the CLI actually reach the container? A binary on the host
  talking HTTP to the exposed port, `docker exec` into the running container, or
  the CLI and server as one process with two entry points? Agents need this to be
  boring and scriptable.
  - A: See Q1 — the hosted-service future implies an HTTP client. Endpoint
    addressing follow-up in **Q49**.
  - A (resolved): **A binary on the host talking HTTP to the exposed port.** Not
    `docker exec` (unscriptable, Docker-dependent, doesn't survive hosting) and not a
    dual-entry-point process (same problems). Base URL and optional token from env/config,
    defaulting to `localhost:8080` — see Q49.
- **Q3.** `P1` `ANSWERED` When the parse is wrong, what is the correction workflow? Original image
  shown side by side with the rendered score, confidence highlighting on uncertain
  notes, a diff view, something else?
  - A: **Side-by-side source image and rendered score, with confidence highlighting.**
    The source image is stored permanently (settling **Q29**) so it can be shown beside
    the result and so the chart can be re-parsed later by a better engine. Low-confidence
    objects and metrically invalid bars are highlighted on screen and carry the same `!`
    flag in the text projection (Q63). Per **Q55**, highlighting is best-effort by object
    type: chord confidence comes cheaply from OCR scores, note and rhythm confidence from
    oemer is patchier.
- **Q4.** `P1` `ANSWERED` One score at a time, or a library of charts with a browse view?
  - A: **A library of charts with a browse view** — list, search, open, delete. SQLite
    (Q61) provides this essentially for free.
- **Q5.** `P0` `ANSWERED` Does "import a PDF" mean a digitally generated PDF with extractable
  vectors and text, or a scan? These are genuinely different pipelines and
  supporting only the scan path is a legitimate MVP choice.
  - A: **Raster only, one pipeline.** Photos (jpg/png/heic), scans, and PDFs
    rasterised to images all go through the same path. No vector or embedded-text fast
    path for digitally-generated PDFs — that would be a genuinely second pipeline with
    its own bugs and its own eval corpus, for a class of input that is not the
    motivating use case.
- **Q6.** `P0` `ANSWERED` What shape is the CLI? Imperative commands (`score note set 12 --pitch
  Bb4`), a patch applied to the score file, or a scripting surface? Separately:
  what does an agent need to *read* in order to reason about the score before it
  acts on it?
  - A: **Imperative verbs**, plus a `batch` wrapper applying a list of the same verbs
    in one transaction. No document-patch endpoint in the MVP. The tradeoff table
    that settled it: verbs win on per-edit context cost, error specificity,
    structural safety (the server constructs the change, so an agent cannot mangle
    the document shape), per-edit conflict retry, and undo; patch wins only on
    atomicity, which the `batch` wrapper buys back. Cost accepted: ~15 verbs to
    design, document and keep stable.
    Consequence: the **op log becomes the spine of the system**, serving the
    single-writer guarantee, undo (Q20) and the testable form of "UI and CLI can
    never disagree" (Q47) simultaneously.
- **Q7.** `P1` `ANSWERED` Repeat barlines, section letters (A / B / bridge), codas, D.S. Double
  barlines are already in, but the rest are still open. Leaving them out risks
  exporting charts a musician cannot read on a stand.
  - A: **Section markers, repeat barlines with 1st/2nd endings, and pickup bars are in.
    D.S., D.C., segno, coda and Fine are out.** Rehearsal letters double as layout
    drivers (Q36). The excluded family is navigation semantics — poorly detected by
    OMR, high correction burden — and a chart is playable off a stand without them
    provided the form is written out.
- **Q8.** `P1` `ANSWERED` Pickup bars and anacrusis. Common in jazz heads. In or out?
  - A: **In.** A pickup bar is bar 0 (Q62) and sits before bar 1 on the first line
    without consuming a four-bar slot (Q36).
- **Q9.** `P0` `ANSWERED` Which kind of transposition? Moving the whole chart to a new concert key
  is one feature; producing a Bb trumpet or Eb alto part from a concert lead sheet
  is a different one that looks similar. Which is the real use case?
  - A: **Both.** Change the concert key of a chart, *and* generate a Bb-trumpet (etc.)
    part. Decided consequence: the score always stores **concert (sounding) pitch**;
    `transpose --to Eb` is a **mutation** that changes the chart, while
    `export --for bb-trumpet` is a **render-time view** that stores nothing. Chord
    symbols transpose along with a written part. Keeping parts as views rather than
    stored variants is what preserves a single truth per chart. Instrument set and
    enharmonic policy still open in **Q10** / **Q60**.
- **Q10.** `P1` `ANSWERED` Enharmonic policy on transpose. How do we choose Bb over A#, and for
  chord symbols how do we pick the spelling a reader expects?
  - A: **Key-signature-driven by default, with a per-object override.** Spelling
    follows the destination key signature (in Eb: Bb and Ab, never A#/G#), chord roots
    respelled the same way. Any note or chord can be pinned to a preferred spelling
    that survives transposition — the escape hatch for chromatic passing chords the
    rule spells wrongly. Implies a spelling field on notes and chords, plus rules for
    how a pinned spelling behaves under transposition.

## Technical

- **Q11.** `P0` `ANSWERED` OMR engine: build it, use an existing one (Audiveris, oemer), or use a
  vision model? Accuracy, cost, offline operation and licence all differ, and
  offline operation is a hard constraint given the local-only requirement.
  - A: None of the offered options. A **three-stage hybrid pipeline** of the user's
    own design:
    1. **Staff segmentation** — an existing tool (object detection model or plain
       image-processing) crops the empty band directly above each recognised staff,
       isolating the chord-text rows from the notation.
    2. **Fine-tuned chord OCR** — not general English OCR. A lightweight text
       recogniser (PaddleOCR, EasyOCR, or a custom TrOCR transformer) fine-tuned
       *exclusively* on a synthetically generated dataset of chord-symbol text
       (root letters + accidentals + jazz extension suffixes).
    3. **Beat mapping** — take note and barline X-coordinates from a base OMR
       engine (oemer or Audiveris) and align the recognised chord bounding boxes to
       those exact beats.
    Consequences: chord recognition is a first-class subsystem, not a by-product of
    OMR; a synthetic data generator and a training/eval harness become real
    deliverables; the stack is almost certainly Python. Follow-ups **Q50**–**Q53**.
- **Q12.** `P0` `ANSWERED` Rendering engine for the on-screen score and the PDF. Same engine for
  both, or two? Verovio, VexFlow, abcjs are the candidates, and whichever we pick
  may settle the React-or-Svelte question for us.
  - A: *"Go with VexFlow for now but based on how it looks I might want to develop
    it on my own."* So VexFlow is the MVP renderer and an explicitly **replaceable**
    one. Implications: we own the model→layout mapping and the four-bar grid
    outright (VexFlow takes no MusicXML), and the renderer needs a real seam so a
    hand-rolled engraver can replace it without touching the model. Follow-ups
    **Q54**–**Q55**.
  - A (addendum, after the "VexFlow can't read MusicXML" objection): that objection
    does not bite — see Q13. The live question is whether to own the engraver, which
    becomes **Q64**. Standing recommendation: keep VexFlow behind the Q58 draw seam
    and gate it on a spike that renders one deliberately nasty chart (4-bar grid,
    ties across barlines, triplets, a pickup, double barlines, dense chord symbols
    including `C7alt` and `F#m7b5`). What VexFlow supplies: SMuFL font + glyph
    metrics, noteheads/stems/flags with stem direction and length, beam grouping and
    slope, accidental stacking, ledger lines, dots, tie/slur beziers, tuplet brackets,
    rest glyph selection, clefs/keys/time signatures, all barline types, and a
    `ChordSymbol` class that does jazz superscript extensions properly. What we own
    either way: the four-bar grid, justification policy, system/page breaking,
    headers, the model, editing and hit-testing.
  - **Amended (ADR-0030, 2026-07-31):** the "for now" ran out. The gate rendered the
    nasty chart, judged VexFlow's output good, and chose to own the engraver anyway —
    jazz typography is this product's differentiator rather than its polish, and 4.2.5
    is the end of a line 5.x cannot continue server-side. `packages/engrave` replaced it
    over V1b–V1d and `packages/draw` and the `vexflow` dependency were deleted. The
    answer above is left as recorded; it was right when it was made.
- **Q13.** `P0` `ANSWERED` MusicXML is verbose and its chord symbol representation (`<harmony>`)
  is awkward. Do we hold our own internal model and treat MusicXML purely as an
  import and export format?
  - A: **Yes.** We own an efficient, agent-friendly internal model; MusicXML is a
    codec at the edges only (import and export), never the runtime truth. Note this
    also neutralises the VexFlow-can't-read-MusicXML objection: some model→renderer
    mapping is required whatever engine we pick, and Verovio's native MusicXML
    support would actively tempt us back toward making MusicXML the truth.
- **Q14.** `P1` `ANSWERED` How do we measure OMR accuracy? This needs a corpus of lead sheet
  photos with hand-verified ground truth, and building it is real work that has to
  be scheduled.
  - A: **Synthetic corpus, built by rendering known MusicXML to images and degrading them**
    (blur, skew, perspective, JPEG noise, shadow) — ground truth is free and there is no
    copyright problem — plus a small set of your own real photos. Settles **Q41**.
- **Q15.** `P0` `ANSWERED` Backend language and runtime. Largely constrained by the OMR choice
  (Audiveris is Java, oemer is Python), so Q11 probably decides this.
  - A: Settled by **Q59** — Node/TypeScript for the API, store, model, layout and PDF;
    Python for the OMR worker only. Q11's oemer choice constrained the worker, not the
    whole backend.
- **Q16.** `P1` `ASSUMED` Triplet brackets and ties are among the harder things for OMR to get
  right. If detection is unreliable for these specifically, is hand-correction an
  acceptable answer, or does that undermine the import feature?
  - A (ASSUMED, correct if wrong): **Hand-correction is the accepted answer, and it does
    not undermine import.** This follows from the product's founding assumption in
    `REQS.md` — every parse is a draft. Ties and triplets specifically get confidence
    flags (Q3/Q55) so the user is pointed at them rather than hunting.

## Success criteria

- **Q17.** `P1` `ANSWERED` What does "parsed correctly" mean in a way we can measure? Note-level
  accuracy against a test corpus, or time-to-correct for a human?
  - A: **Both, with different jobs.** Note-level accuracy, chord-level accuracy and
    percentage of metrically valid bars are the *tracking* metrics, measured on the
    synthetic corpus every run. The *ship gate* is a human-time target (Q42) — an accuracy
    percentage can look fine while the errors cluster in one phrase and the feature still
    feels awful.
- **Q18.** `P0` `ANSWERED` Who is the primary user, a gigging musician digitising their book or an
  agent-driven workflow? This changes what we optimise and how much the UI
  matters relative to the CLI.
  - A: **Both equally, personal tool.** True parity is a design constraint from day
    one: every capability lands in a shared core with both a CLI verb and a UI
    control, and no capability exists on only one surface. Costs more per feature,
    but nothing gets retrofitted. Note the tension with Q48 (a hosted service has
    users who are not you) — personal *now*, service later.

---

# Added by /grill-with-docs (round 1)

## State, storage and concurrency

- **Q19.** `P0` `ANSWERED` Where does score data physically live? A directory of human-visible
  files the user can put in git and diff, or an opaque app-managed store (SQLite)?
  This decides whether "the CLI edits my chart" is inspectable, and whether
  version history is free or something we build.
  - A: Directive was "whatever is easier to transition to a web app", which decides
    **SQLite**: it maps onto Postgres nearly 1:1 (relational, transactional,
    row-version optimistic concurrency), whereas files-on-disk map onto nothing in a
    hosted world — you would write the database layer then anyway, plus a migration.
    SQLite also gives the library/browse view (Q4) and single-writer transactions for
    free. Recommended shape (confirm in **Q61**): the score as a **JSON document in
    one column** plus extracted columns for listing (id, owner, title, composer, key,
    updated_at, version); original images and exported PDFs in a local directory
    behind a blob-store interface, S3-compatible later.
- **Q20.** `P1` `ANSWERED` Is there an undo history, and is it shared between UI and CLI? If an
  agent makes twelve edits, can the human undo them one at a time, all at once, or
  not at all?
  - A: **Yes, shared, from the op log.** Undo is per score, walks the op log backwards,
    and is the same history whoever made the edit. An agent's `batch` (Q6) is one
    undoable unit; individual ops undo individually. Exposed as `sibei undo` / `redo` and
    ctrl-Z in the UI.
- **Q21.** `P0` `ANSWERED` Concurrency policy on write. If the CLI writes while the UI holds
  unsaved local state, who wins? Options: every write carries a version and a
  stale write is rejected; last-write-wins; or an explicit lock. "Never disagree"
  needs one of these picked explicitly.
  - A: Settled by **Q48** and **Q6**. Every write carries an expected version; a stale
    write is rejected with the current version so the client can retry. No locks, no
    last-write-wins. The op log is the ordering authority.
- **Q22.** `P0` `ANSWERED` Filesystem boundary. Does the container get a mounted host directory
  for input images and output PDFs, or does everything move over HTTP as
  upload/download? An agent typing `score import ./photo.jpg` only works if the
  container can see that path.
  - A: Settled by **Q48**. The API takes uploads and serves downloads over HTTP and
    never accepts a host path; scores are opaque IDs. A mounted host directory is a
    purely local *convenience* the CLI may use to read a file before uploading it, so
    `sibei import ./photo.jpg` works — but it is never the mechanism.
- **Q47.** `P1` `ASSUMED` What is the testable definition of "the UI and CLI can never
  disagree"? A single write path both go through plus a test that asserts it, or
  something weaker?
  - A (ASSUMED, correct if wrong): **Yes, and it is testable three ways.** (1) The CLI is
    an HTTP client of the same API the UI calls — there is no second write path to
    diverge. (2) Every mutation goes through one op applier, asserted by a test that the
    only writes to the store come from it. (3) A property test: replaying a score's op log
    from empty reproduces the stored document exactly.

## CLI contract

- **Q23.** `P1` `ASSUMED` Does every command emit machine-readable output (JSON always, or a
  `--json` flag), and are exit codes meaningful enough for an agent to branch on
  failure without parsing prose?
  - A (ASSUMED, correct if wrong): human-readable output by default, `--json` for
    structured output on every command, and meaningful exit codes — distinct codes for
    stale-version conflict, invalid address, and validation failure — so an agent can
    branch without parsing prose.
- **Q24.** `P0` `ANSWERED` The agent read surface. Is there a compact, lossy, human/LLM-readable
  text projection of the score (something like a bar-by-bar text chart) so an agent
  can reason cheaply, in addition to the full structured dump? Reading raw MusicXML
  into a context window is expensive and error-prone.
  - A: **Yes, emphatically wanted.** A compact bar-by-bar text projection of the
    chart that an agent reads instead of MusicXML, and which prints the addresses the
    CLI accepts. Exact format open in **Q63**.
- **Q25.** `P0` `ANSWERED` Are edits addressed by stable object IDs (`note-17`) or by musical
  position (bar 12, beat 3)? Positions shift the moment a duration changes; stable
  IDs have to survive a round-trip through MusicXML, which has no natural place to
  put them.
  - A: **Both, with different roles.** The internal model carries stable IDs; the CLI
    addresses by **musical position** for readability, and accepts IDs too. IDs are
    app-owned and need not survive a MusicXML round-trip. Three rules follow
    (details in **Q62**): positions address *onsets only* and a miss is an error that
    lists the real onsets in that bar; ordinal addressing (`bar12.n3`) is supported
    alongside beats because post-import rhythms are exactly what is wrong, making
    beat positions unreliable when correcting a parse; and `sibei show` output prints
    the addresses it accepts so an agent never guesses one.

## Import pipeline

- **Q26.** `P1` `ASSUMED` Is one input always one chart? What about a two-page tune, or a single
  photo of a page containing two tunes?
  - A (ASSUMED, correct if wrong): **One chart may come from several images.** `import`
    accepts 1..n images applied in order, so a two-page tune works. One photo containing
    two different tunes is not supported — the user crops.
- **Q27.** `P1` `ASSUMED` Image preprocessing (deskew, crop, contrast, perspective correction):
  automatic, a user step with a crop UI, or out of scope and the user is told to
  take a better photo?
  - A (ASSUMED, correct if wrong): **Automatic in the worker** — deskew, perspective
    correction, crop to the page, contrast normalisation via OpenCV. No crop UI in the
    MVP; a bad photo is re-taken rather than repaired interactively.
- **Q28.** `P1` `ASSUMED` Failure behaviour. When OMR produces garbage or nothing, is the result
  an empty score, a partial score with gaps flagged, or a hard error? And
  separately: is there a "new blank chart" path so the app is fully usable with no
  import at all?
  - A (ASSUMED, correct if wrong): **Partial score with gaps flagged is the normal
    failure mode**; a hard error only when no staff is detected at all. And yes — `sibei
    new` creates a blank chart, so the app is fully usable with no import, which CLI
    parity (Q18) requires anyway.
- **Q29.** `P1` `ANSWERED` Is the original image kept alongside the score permanently — for the
  side-by-side correction view, and so a chart can be re-parsed later by a better
  engine?
  - A: **Yes, permanently** — see Q3. Both for the correction view and to allow re-parsing
    the same chart with a better engine later.
- **Q30.** `P0` `ANSWERED` Handwritten charts in scope, or printed/engraved only? A phone photo
  of a Real Book page and a photo of someone's manuscript are very different OMR
  problems, and most engines only do the former.
  - A: **Printed/engraved only. Handwritten manuscript is out of scope** — oemer is
    not trained for it, and supporting it would need different models and its own
    corpus.
- **Q40.** `P0` `ANSWERED` Is "local only, no network" absolute, or may a vision-model OMR path
  exist as an explicitly opt-in online mode with an offline engine as the default?
  - A: Settled by **Q11** and **Q53** — the pipeline is entirely local (oemer +
    off-the-shelf OCR + grammar corrector). No vision-model path, opt-in or otherwise,
    in the MVP; the runtime needs no network. See **Q50** for how this is worded once a
    hosted deployment exists.
- **Q41.** `P1` `ANSWERED` Where does the evaluation corpus come from, given that published lead
  sheets are copyrighted? Options include rendering known MusicXML to images and
  photographing printouts (synthetic ground truth), or hand-labelling your own
  charts.
  - A: See Q14 — synthetic ground truth from rendered MusicXML, plus a small hand-labelled
    set of your own photos. Avoids keeping or sharing a corpus of copyrighted charts.
- **Q42.** `P1` `ANSWERED` What accuracy bar makes import a shippable feature rather than a
  demo? A note-level percentage, or a human-time target ("I can fix a 32-bar head
  in under two minutes")?
  - A: **A human-time gate: a 32-bar head should be correctable by hand in roughly two
    minutes.** Accuracy percentages track progress; this decides shippability.

## Music model

- **Q31.** `P0` `ANSWERED` Chord symbol vocabulary. Which qualities and extensions must
  round-trip (maj7, m7b5, alt, 13#11, slash chords, `N.C.`)? Free text with a
  parser, or a closed set the UI offers?
  - A: **Open grammar parsing to structure.** Chord text parses into
    root / quality / extensions / alterations / bass — `Cmaj7`, `F#m7b5`, `C7alt`,
    `Bb13#11`, `Ab/Eb`, `N.C.` — and text the grammar cannot parse is kept verbatim and
    flagged rather than rejected or silently dropped. Per Q53 this grammar does double
    duty: it is the OCR error-correction mechanism *and* the validator for what a user
    or agent types.
- **Q32.** `P1` `ANSWERED` Are chord symbols anchored to a bar or to a beat position within the
  bar? Two chords in one bar forces beat anchoring.
  - A: **Beat position within the bar.** Forced by the requirement itself (two chords in
    one bar is routine in jazz) and already assumed by the beat-mapping stage of the OMR
    pipeline (Q11) and by the text projection's `Ebm7@1, Bb7@3` notation (Q63).
- **Q33.** `P0` `ANSWERED` Rhythmic validation. Must every bar sum to the time signature? Import
  will routinely produce bars that don't — do we reject, auto-repair, or store the
  invalid bar and flag it?
  - A: **Store and flag, never reject.** A bar whose durations do not sum to the meter
    is stored as-is and flagged for review; the UI and the text projection surface the
    flag; export warns but does not refuse. Rationale: OMR produces metrically invalid
    bars constantly, and rejecting them would force a repair stage that guesses — the
    user would then be correcting the repair rather than the parse.
- **Q34.** `P2` `ASSUMED` Mid-chart time signature changes: in or out? (Default assumption: out
  for MVP, one time signature per chart.)
  - A (ASSUMED, correct if wrong): **Out.** One time signature per chart in the MVP.
- **Q35.** `P1` `ASSUMED` Rests. `REQS.md` lists notes but never rests, and a lead sheet has
  them. Explicit rest objects in the model, or implied gaps?
  - A (ASSUMED, correct if wrong): **Explicit rest objects.** Lead sheets have rests, and
    metric validation (Q33) cannot work without them being first-class.
- **Q36.** `P0` `ANSWERED` How does four-bars-per-line survive reality? What happens when the bar
  count isn't a multiple of four, when there's a pickup bar, and when a section
  change lands mid-line — does the line break move to respect the section, or does
  the four-bar grid always win?
  - A: **Four-bar grid by default; a section boundary may break it.** A double barline
    or rehearsal letter forces a line break even mid-line, so an 11-bar A section lays
    out 4/4/3. A pickup sits before bar 1 on the first line without consuming a slot.
    Rationale: musicians read by section, so a bridge starting mid-line is wrong even
    though it keeps the grid perfectly regular.
    **Consequence for Q7:** section boundaries are now load-bearing for *layout*, not
    only notation — so section markers must exist in the model regardless of how much
    of the repeat / coda / D.S. family we support.

## Export

- **Q37.** `P1` `ASSUMED` PDF header content: title, composer, key, tempo/style marking. Where
  does that metadata come from on import (do we OMR the title text?) and is it
  editable in the UI and from the CLI?
  - A (ASSUMED, correct if wrong): **Title, composer, key, and an optional style/tempo
    text line.** Import attempts the title and composer with the same OCR used for chords,
    flagged low-confidence like anything else. All fields editable from both the UI and
    the CLI.
  - **Amended (V3b, 2026-07-31), on the key:** the header prints **title, composer and the
    style line only**. The key is not header text — it reaches the page as the **key
    signature on the stave**, which is how a lead sheet states its key, and printing
    "key Db" above a chart already showing five flats is redundant and un-idiomatic. The
    assumption was written before there was an engraver to state it any other way. Nothing
    else in the answer changes: the key is still metadata on the score, still derived into
    the library's listing columns, and still editable from both surfaces with `meta set
    --key`. `buildHeader` in `packages/layout/src/layout.ts` is the whole of the header, and
    `tests/e2e/render-long-form.test.ts` holds it to those three roles and to two flats at
    the head of every system on every page.
- **Q38.** `P2` `ASSUMED` Page size and pagination. A4, Letter, or both? How many staff lines
  per page, and what happens to a chart that doesn't fit one page?
  - A (ASSUMED, correct if wrong): **A4 and Letter, A4 default.** A chart flows onto
    further pages when it does not fit; no attempt to squeeze a long tune onto one page.
- **Q39.** `P1` `ASSUMED` Is the PDF produced by the same renderer as the screen (one engine,
  SVG to PDF), and do we need deterministic byte-stable output so exports can be
  regression-tested?
  - A (ASSUMED, correct if wrong): **Same renderer, and yes deterministic.** Regression
    tests snapshot the **SVG**, not the PDF bytes — PDF carries creation timestamps and
    producer strings that would make byte comparison flaky. PDF metadata is pinned to
    fixed values so exports are reproducible.

## Delivery and ops

- **Q43.** `P1` `ASSUMED` Image size and hardware. An OMR model plus a Java or Python runtime
  could make a multi-gigabyte image. Is that acceptable, and is GPU allowed to be
  required or must it run CPU-only?
  - A (ASSUMED, correct if wrong): **CPU-only is a hard requirement; GPU is optional
    acceleration only.** A multi-gigabyte image is accepted as the cost of a local OMR
    pipeline.
- **Q44.** `P1` `ASSUMED` One container or several (frontend, API, OMR worker)? And is a long
  OMR run a synchronous HTTP request or a job the client polls?
  - A (ASSUMED, correct if wrong): **Two containers via compose** — `api` (Node: HTTP API,
    SQLite, model, layout, PDF) and `worker` (Python: oemer + OCR). The worker never
    touches the database; it receives an image and returns JSON, which keeps the
    single-writer guarantee intact. Import is a **job**: the API records it, calls the
    worker, and the client polls or subscribes. Blobs live on a shared volume behind the
    `BlobStore` interface.
- **Q45.** `P1` `ANSWERED` Is this a personal tool or something other people install? Decides how
  much install polish, docs and error-message quality the MVP owes.
  - A: Settled by **Q18** — a personal tool for now. Install polish, onboarding docs and
    error-message quality are sized accordingly, with the caveat that the hosted future
    (Q48) will raise the bar later.
- **Q46.** `P2` `ASSUMED` Any authentication on the local HTTP API? (Default assumption: none,
  bound to localhost only, documented as a trusted-machine assumption.)
  - A (ASSUMED, correct if wrong): **No authentication locally.** The API binds to
    localhost and the auth seam (Q48) resolves every request to the single principal
    `local`. Documented as a trusted-machine assumption.

---

# Added by /grill-with-docs (round 2)

Arising from the round-1 answers.

## The hosted-service future

- **Q48.** `P0` `ANSWERED` "Eventually a web app people can use on the web" — do we build the
  hosted service now, or build local-first under constraints that make hosting a
  deployment change? Recommendation on the table: local-first, plus eight
  now-decisions (API is the only writer · no host paths in the API · store behind a
  repository interface · owner field from day one · auth as a resolvable seam · OMR
  as a job not a request · stateless API · CLI takes base URL + token). Explicitly
  not built now: signup, billing, TLS, cloud storage, rate limiting.
  - A: **Local-first, hosting-shaped.** All eight now-decisions adopted. The MVP is
    the local container with a single local principal; hosting is a later deployment
    change, not a rewrite. Signup, billing, TLS, cloud storage and quotas are
    explicitly out of MVP scope. This also settles **Q1**, **Q2**, **Q21** and
    **Q22** by implication (see those entries).
- **Q49.** `P1` `ASSUMED` In the hosted future, what is the CLI? The same binary pointed at a
  remote base URL with a token, or does the CLI stay a local-only tool while the
  web app grows its own surface? Decides whether the CLI's contract is
  "localhost convenience" or "the public API".
  - A (ASSUMED, correct if wrong): **The same binary, pointed at a base URL with an
    optional token**, both from env/config, defaulting to `localhost:8080` with no token.
    So the CLI's contract *is* the public API, not a localhost convenience — which means
    it needs to be versioned and kept stable from the start.
- **Q50.** `P1` `ASSUMED` Does the hosted future change what "no network dependency" means in
  `REQS.md`? Proposal: reword it as a statement about the MVP deployment (the local
  container needs no network) rather than an architectural prohibition.
  - A (ASSUMED, correct if wrong): **Yes, reword it.** `REQS.md`'s "no hosted service, no
    accounts, no network dependency at runtime" becomes a statement about the MVP
    *deployment* — the local container requires no network — rather than an architectural
    prohibition, which Q48 has now superseded.
- **Q51.** `P1` `ASSUMED` Copyright exposure. A local tool photographing your own book is not
  the same as a service where strangers upload copyrighted charts. Is that a
  consideration you want recorded now (and does it argue for keeping the hosted
  version BYO-image, or account-scoped and private by default)?
  - A (ASSUMED, correct if wrong): **Recorded now, not acted on now.** A local tool where
    you photograph your own book is a materially different position from a service where
    strangers upload copyrighted charts. Noted as a gate on the hosted transition: uploads
    private and account-scoped by default, no shared or public chart library, no corpus
    built from user uploads.

## OMR hybrid pipeline follow-ups

- **Q52.** `P0` `ANSWERED` Which base OMR engine supplies notes, barlines and X-coordinates for
  stage 3 — oemer or Audiveris? This decides the backend runtime (Q15): oemer keeps
  everything in one Python process alongside the OCR model; Audiveris adds a JVM
  and a subprocess boundary but is stronger on rhythm and barlines.
  - A: **oemer.** Whole pipeline in one Python process — segmentation, crop, OCR and
    beat mapping share image arrays; MIT licence keeps the hosted future clean.
    Accepted weak spots: complex rhythm and barline classification, which is exactly
    where hand-correction (Q16) has to carry the load. Raises **Q59** — the backend
    now needs both Python (oemer) and Node (server-side VexFlow).
- **Q53.** `P0` `ANSWERED` Is training the fine-tuned chord OCR model inside MVP scope? It
  implies a synthetic data generator, a training loop, a checkpoint to ship in the
  image, and an eval harness — a subproject. Alternative staging: MVP ships
  off-the-shelf OCR plus a chord-grammar corrector (constrain output to legal chord
  symbols, which fixes most OCR errors cheaply), and fine-tuning lands as stage 2
  once the eval harness exists and can prove it helped.
  - A: **Staged.** MVP ships off-the-shelf OCR (PaddleOCR or EasyOCR) plus a
    chord-grammar corrector that snaps recognised text to the nearest legal chord
    symbol, and an eval harness that measures chord accuracy. Fine-tuning on
    synthetic data is stage 2, kept only if the harness shows it moved the number.
    Makes the chord grammar (**Q31**) load-bearing: it becomes the error-correction
    mechanism, not merely a vocabulary. Q54 therefore becomes a stage-2 question.
- **Q54.** `P1` `DEFERRED` (stage 2, per Q53) The synthetic chord-symbol dataset: which fonts (engraving fonts vs
  text fonts vs handwriting-ish), what grammar of symbols does it enumerate, and
  does it also synthesise the *degradations* — blur, skew, perspective, JPEG noise,
  paper texture, shadow — without which a model trained on clean renders won't
  transfer to phone photos?
- **Q55.** `P1` `ANSWERED` Does the pipeline emit per-object confidence that reaches the UI for
  Q3's highlighting? OCR gives per-character scores cheaply; note/rhythm confidence
  from oemer or Audiveris is patchier. Is chord-only confidence highlighting
  acceptable for the MVP?
  - A: **Best-effort per object type, and yes it reaches the UI.** Chord confidence from
    OCR scores, note/rhythm confidence from oemer where available, plus the derived
    metric-validity flag from Q33 which is reliable regardless of engine confidence.
- **Q56.** `P1` `ASSUMED` Stage 1 crops "the band above each staff". What happens to chord
  symbols that a real chart puts *elsewhere* — inside the staff area, below it, or
  overlapping a high melody note? And what about text in that band that is not a
  chord (rehearsal letters, "Latin feel", section names, page headers)?
  - A (ASSUMED, correct if wrong): text found in the band above a staff that the chord
    grammar cannot parse is **kept as a text annotation on the bar and flagged**, not
    discarded — that is how "Latin feel" and section names survive. Rehearsal letters are
    matched separately by pattern (a lone capital, often boxed). Chord symbols placed
    anywhere other than the band above the staff are **missed** in the MVP; the user adds
    them by hand, and the side-by-side view (Q3) is what makes that discoverable.

## Renderer follow-ups

- **Q57.** `P1` `ANSWERED` With VexFlow chosen, how is the PDF produced? Options: run VexFlow in
  Node server-side and convert SVG to PDF; render in the browser and print via
  headless Chromium; or a separate PDF drawing path. Determinism matters if exports
  are to be regression-tested (Q39).
  - A: **Node-side VexFlow → SVG → PDF.** Same VexFlow code runs server-side; screen
    and print share one layout path; output is deterministic and therefore
    regression-testable. Raises **Q59** (two backend runtimes).
  - **Amended (ADR-0030, 2026-07-31):** the shape of this answer survived; only the
    engine changed. It is Node-side **engraver** → SVG → PDF now, and determinism got
    cheaper rather than harder: the engraver emits markup rather than DOM nodes, so
    `packages/pdf` dropped jsdom and every music glyph is a `<path>` from the font's own
    outline, with nothing embedded or subsetted. Byte-identity is a property of the
    design now instead of something stripped out of a renderer's element ids.
- **Q58.** `P1` `ANSWERED` Since VexFlow may be replaced by your own engraver later, is the
  renderer boundary an explicit interface — model → layout (systems, bars,
  positions) → draw primitives — so a replacement is contained to the draw layer?
  Doing this now costs a little; not doing it makes the replacement a rewrite.
  - A: **Yes, explicit seam.** Layout (systems, bars, x/y positions, the four-bar
    grid) is ours and engine-independent; drawing goes through an adapter with a
    VexFlow implementation. Replacing VexFlow with a hand-rolled engraver touches
    only the draw adapter.
  - **Amended (ADR-0030, 2026-07-31):** this is the answer in this file that paid off
    most. The replacement happened, and it touched only the draw adapter exactly as
    predicted — `layout` did not change and no note moved on the page. `packages/draw`
    is gone; the seam it sat behind is now `packages/engrave` and is the only adapter
    contract there is.

---

# Added by /grill-with-docs (round 3)

- **Q59.** `P0` `ANSWERED` Two backend runtimes now: Python (oemer, OCR) and Node (server-side
  VexFlow for PDF). Which one is the API server and which is the worker? Options:
  (a) Python owns the API and the store, Node is a small render service called for
  PDF; (b) Node owns the API, Python is an OMR worker; (c) both behind a thin
  gateway. Whichever way, one process must own the score store (Q48's stateless-API
  and single-writer decisions).
  - A: **Node/TypeScript owns the API, the SQLite store, the model, the ops, the
    layout engine, PDF generation and the chord grammar. Python is an OMR worker**
    invoked as a job (Q48's job-not-request decision), returning raw musical objects
    plus OCR text and confidence. Deciding factor: the layout engine must run in the
    browser *and* server-side for PDF, and in TS that is literally the same file in
    both places — the browser re-renders instantly on edit with no round trip, which
    also matters once hosted. Bonus: the heavy OMR runtime is isolated and can scale
    separately in a hosted deployment. This settles **Q15**.
    Note the chord grammar deliberately lives in TS with the model, not in Python
    beside the OCR, so there is one implementation serving both import correction and
    validation of what a user or agent types.

---

# Added by /grill-with-docs (round 4)

- **Q60.** `P1` `ANSWERED` Which instruments get part generation, and what does a part change
  besides pitch? Bb (trumpet, tenor, clarinet), Eb (alto, bari), F (horn)? Note the
  transpositions are not all within an octave — tenor sax is written a major ninth
  above concert, alto a major sixth — so a part changes written octave and key
  signature, not just pitch class. Does the MVP handle octave placement properly, or
  ship Bb-and-Eb-within-an-octave only?
  - A: **Bb, Eb and F parts with correct octave handling.** bb-trumpet (M2 up),
    bb-tenor (M9 up), eb-alto (M6 up), eb-bari (M13 up), f-horn (P5 up). A part
    changes written octave *and* key signature, not just pitch class.
- **Q61.** `P0` `ANSWERED` (asked round 5) Confirm the storage shape: score as a **JSON document in a single
  SQLite column**, plus extracted columns for listing (id, owner, title, composer,
  key, updated_at, version); images and PDFs in a local directory behind a
  blob-store interface. Alternative is normalised note/chord tables, which means
  hand-rolling an ORM for musical objects and complicates the atomic version check.
  - A: **Confirmed as recommended.** `scores(id, owner, title, composer, key,
    updated_at, version, doc JSON)`; blobs (source images, exported PDFs) behind a
    `BlobStore` interface — local directory now, S3-compatible later. Normalised
    note/chord tables rejected: a mini-ORM for musical objects plus per-read/write
    joins and a harder atomic version check, in exchange for a cross-chart query
    capability the MVP does not need.
- **Q62.** `P0` `ANSWERED` (asked round 5) Confirm the three addressing rules: (a) positions address **onsets
  only**, and a miss errors with the real onsets in that bar listed; (b) ordinal
  addressing `bar12.n3` supported alongside `bar12.beat3`, because post-import
  rhythms are exactly what is wrong and beat positions are least reliable when
  correcting a parse; (c) a pickup bar is **bar 0**, so bar 1 is the first full bar.
  - A: **All three confirmed.** Strict onset addressing chosen over snap-to-nearest
    specifically because snapping lets an agent edit the wrong note and never find
    out; an error listing the real onsets is recoverable, a silent mis-edit is not.
- **Q63.** `P0` `ANSWERED` What exactly does the agent-facing text projection look like? It has
  to carry: chord symbols per bar with beat placement, melody pitches and rhythms,
  bar numbers, the addresses the CLI accepts, and per-object confidence or
  needs-review flags after an import. Compactness and completeness pull against each
  other here.
  - A: **Grid chart plus per-bar melody lines, with addresses inline.** Four-bar rows
    matching the printed layout, chord symbols carrying beat placement, then melody
    per bar with each note's address shown, and `!` marking low-confidence objects
    needing review. Shape:

    ```
    Body and Soul — key Db, 4/4, 32 bars
      ! = needs review (low confidence)

     1 |Ebm7      Bb7       |Ebm7  Ab7 |...
       bar1  n1 db5/8  n2 eb5/8  n3 f5/4
       bar2  n1 gb5/2  n2 f5/4 !
       bar3  n1 eb5/4~ n2 eb5/8 (tie)
    ```

    The projection prints the addresses the CLI accepts, so an agent never guesses
    one. Reads the chart shape at a glance while staying addressable.
- **Q64.** `P0` `ANSWERED` VexFlow behind the draw seam with a spike gate, or own the engraver
  from the start? A lead sheet is the easiest engraving target there is (single
  staff, one voice, no dynamics, no multi-voice collisions), so owning it later is
  perhaps 15% of a general engraver rather than the whole thing — which is the
  argument for not paying that cost before seeing VexFlow's actual output.
  - A: **VexFlow behind the draw seam, with a spike gate.** Ship on VexFlow; early in
    the build, render the nasty test chart (4-bar grid, ties across barlines,
    triplets, pickup, double barlines, `C7alt`, `F#m7b5`) and judge the output. If it
    fails, replace the draw adapter only — layout, model and app untouched. Owning
    the engraver stays a live option, deliberately deferred until there is evidence
    it is needed.
  - **Amended (ADR-0030, 2026-07-31):** the gate ran and the deferred option was taken.
    Note *how* it resolved, because it is not the branch this answer anticipated: the
    output did **not** fail — it was good, readable off a stand. The gate produced
    evidence of a different kind, that jazz typography is the differentiator and that
    4.2.5 is a dead branch, and the decision went the other way on that. The staging in
    this answer is what made it cheap: `docs/v1-render-gate.md`, then
    `docs/v1b-engraver-spike.md`, then V1c–V1d. Left as recorded — this is the decision
    of the day, not the state of the code.

---

# Added by /grill-with-docs (round 7 — final consistency pass)

Found by re-reading `CONTEXT.md` and `docs/adr/*.md` against `REQS.md` and against
each other. These are real conflicts, not wording nits.

- **Q65.** `P1` `ANSWERED` **React or Svelte?** `REQS.md` says "either is fine, the choice can
  fall out of whichever rendering library we settle on" — but VexFlow is
  framework-agnostic, so nothing falls out and the question is still live. Note the
  framework does unusually little work here: the score surface is SVG driven by our own
  layout engine (ADR-0015), not a component tree.
  - Note: an "agent familiarity" argument was offered for React and **withdrawn as
    invalid** — agents interact only through the CLI and API and never touch the
    frontend framework. The only tiebreaker that survives is that Claude writes more
    idiomatic React than Svelte (Svelte 5 runes being recent), which is an argument about
    the author, not the product.
  - A: **Svelte 5 with Vite.** Less boilerplate and a smaller bundle for an app whose
    component surface is small — shell, split-pane, upload, forms, library table, review
    flags. The invariant that makes this low-risk is one the architecture already
    requires: the model, layout engine, chord grammar and ops are plain framework-free
    TypeScript, and the framework touches only the shell. Settles `REQS.md`'s
    "React or Svelte" and supersedes its claim that the choice would fall out of the
    rendering library.
- **Q66.** `P0` `ANSWERED` **Is import itself an operation in the op log?** ADR-0003 says the op
  applier is the only writer and that replaying a log from empty must reproduce the
  document. An import creates a whole score at once. Either it is one big `import` op
  carrying the parsed document (log stays complete, undoing an import means an empty
  score), or score creation sits outside the log (breaks the replay property). Which?
  - A: **Import is one op carrying the whole parsed document.** The log stays complete and
    replay-from-empty holds as a property. Undoing an import leaves an empty score.
- **Q67.** `P1` `ANSWERED` **How does undo actually work on the log?** Forward ops only, undoing
  by replaying from empty minus the last op (simple, exact, O(n) per undo), or inverse
  ops stored alongside (O(1) undo, but every op needs a correct inverse — and getting an
  inverse subtly wrong corrupts state silently)? Documents are small, which argues for
  replay.
  - A: **Forward ops only; undo replays the log minus the last op.** Exact by
    construction, O(n) but n is small and documents are kilobytes. Inverse ops rejected
    because 15 verbs each need a provably correct inverse, and a subtly wrong inverse
    corrupts state with no error at all.
- **Q68.** `P1` `ANSWERED` **Does API/CLI versioning discipline start now or at the hosted
  transition?** Q18 says personal tool; Q49 says the CLI's contract *is* the public API
  and therefore needs versioning from the start. Those pull against each other. Cheap
  middle option: version the API path (`/v1/`) from day one but allow breaking changes
  within v1 until the hosted transition, then freeze.
  - A: **`/v1/` in the path from the first commit, with breaking changes allowed inside
    v1 until the hosted transition, then frozen and additive-only.** Costs nothing now
    and avoids retrofitting a version prefix onto a shipped CLI, without pretending to a
    stability the personal-tool phase does not need.
- **Q69.** `P0` `ANSWERED` **Can double barlines and repeats actually be detected on import?**
  `REQS.md` requires double barlines "detected on import", and ADR-0021 adds repeats
  with endings — but ADR-0010 accepts that barline classification is one of oemer's two
  known weak spots. So a requirement rests directly on an accepted weakness. Options:
  accept that these are usually hand-added and stop calling them "detected"; add a
  dedicated barline classifier stage (the chord-band trick already proves the pattern of
  bolting a specialist onto oemer's output); or treat barline detection accuracy as its
  own tracked metric with its own gate.
  - A: **Accept hand-addition and stop calling them "detected".** Import produces single
    barlines only; double barlines, repeats, endings and section markers are added by
    hand. No dedicated barline classifier stage in the MVP.
    Consequence accepted and rippled: because section boundaries drive line breaking
    (ADR-0015), a freshly imported chart lays out on a plain four-bar grid and its line
    breaks will be wrong until sections are added. The correction view should therefore
    prompt when a score has no sections. `REQS.md`'s "double barlines … detected on
    import" becomes a fourth superseded sentence (Q70).
- **Q70.** `P1` `ANSWERED` **Reconcile `REQS.md` with the decisions of record.** Three sentences
  in `REQS.md` are now contradicted rather than merely refined:
  1. *"No hosted service, no accounts, no network dependency at runtime"* — superseded by
     ADR-0001; true of the MVP deployment, not of the architecture.
  2. *"Parse into a real interchange format rather than something bespoke"* — ADR-0004
     does the opposite: a bespoke model is the truth and MusicXML is a codec at the
     edges. The *intent* (scores can leave the app) is satisfied; the sentence is not.
  3. *"The frontend is React or Svelte with Vite (either is fine, the choice can fall out
     of whichever rendering library we settle on)"* — the choice does not fall out. See
     Q65.
  Should `REQS.md` be edited to match, or left as the historical record with a pointer to
  `CONTEXT.md`?
  - A: **Leave `REQS.md` as the historical record**, with a header saying `CONTEXT.md`
    supersedes it where they differ, plus inline markers on the superseded sentences —
    now four, including the double-barline detection claim from Q69. The original
    thinking stays readable, which is worth keeping.

---

# Added by /plan-new-project (resume mode — coverage checklist gaps)

Answered questions and accepted ADRs above are binding and were not re-opened. These
are gaps the coverage checklist found, plus three dependency facts verified rather
than assumed.

## Verified dependency facts

- **Q71.** `P0` `ASSUMED` **Are oemer's note and barline pixel coordinates actually
  reachable?** Stage 3 of the pipeline (ADR-0010) depends on them entirely. oemer's
  docs describe internal `Staff`, `NoteHead`, `NoteGroup`, `Barline` and `Rest`
  objects carrying coordinates and attributes, but **do not state that these are a
  public API** — the CLI emits only MusicXML, which has no coordinates at all. This is
  the single most load-bearing unverified assumption in the plan.
  - A (ASSUMED, correct if wrong): import oemer **as a library** rather than shelling
    out to its CLI, and prove coordinate access in a spike *before* any app code is
    written. Contingency if the internals are private or unstable: vendor a fork of
    oemer (MIT permits it) and expose the objects we need. Re-deriving coordinates
    ourselves from the segmentation output is the fallback of last resort, and would
    make the beat-mapping design substantially more expensive.
- **Q72.** `P0` `ANSWERED` **CPU-only import latency.** oemer's own documentation states a
  typical run takes **3–5 minutes with a GPU**. Q43 mandated CPU-only. A CPU run will
  be materially slower, which changes what the import UX has to be. Escalated as a
  fork.
  - A: **CPU-only stays the hard floor; GPU is an opt-in compose profile.** The app must
    always run without special hardware. Real CPU wall-clock is measured in the oemer
    spike (Q71) and documented. Because import is already a job (ADR-0001), a slow import
    is a progress bar you can walk away from rather than a hang. Recorded in ADR-0025.
- **Q73.** `P0` `ASSUMED` **Model weights must be baked into the image at build time.**
  oemer downloads its checkpoints on first run, taking up to ten minutes, and
  PaddleOCR/EasyOCR do the same. Left alone this **breaks the offline requirement
  outright** — a fresh container's first import would need the network.
  - A (ASSUMED, correct if wrong): the Dockerfile fetches every checkpoint at **build**
    time and bakes it in. The container never downloads a model. This is also what
    makes the image multi-gigabyte, so Q43's acceptance of image size is load-bearing
    rather than incidental. A build-time integrity check (pinned checksums) guards
    against a silently changed upstream artefact.
- **Q74.** `P1` `ASSUMED` **PaddleOCR or EasyOCR** for the chord-band recogniser
  (ADR-0011)? Both are Apache-2.0 and both run fully offline.
  - A (ASSUMED, correct if wrong): **PaddleOCR**, because it has the more accessible
    documented fine-tuning pipeline — and fine-tuning on synthetic chord symbols is
    precisely what stage 2 of ADR-0011 is. EasyOCR is easier to install, which matters
    less than making stage 2 cheap.
- **Q75.** `P1` `ASSUMED` **`homr` as an alternative base engine.** oemer's own README
  calls homr "an awesome improved version of this project", and homr is purpose-built
  for camera photos of sheet music — so it deserved checking.
  - A (ASSUMED, correct if wrong): **rejected, and it strengthens the oemer choice
    rather than threatening it.** Three reasons. (1) homr is **AGPL-3.0**, and avoiding
    AGPL was an explicit reason for choosing oemer over Audiveris given the hosted
    future. (2) It outputs **MusicXML only, with no exposed coordinates** — so stage 3
    of our pipeline could not work at all. (3) It explicitly covers only pitch and
    rhythm, "neglecting dynamics, articulation … and other musical symbols", so it
    brings nothing to chord recognition. Worth noting oemer's last release is
    **October 2023**, so we are building on a quiet dependency — mitigated by MIT
    licensing making a vendored fork always available.

## Coverage gaps

- **Q76.** `P0` `ANSWERED` **Does the MVP ship in one milestone or two?**
  - A: **Two.** **v0.1** delivers create, edit, transpose, export, library, undo and CLI
    parity — a complete, useful, fully testable product that depends on none of the risky
    OMR work. **v0.2** adds import onto a foundation already proven by use. If OMR
    disappoints, v0.1 has still shipped. Recorded in ADR-0026.
- **Q77.** `P1` `ASSUMED` **Stored document schema versioning.** The score JSON document
  (ADR-0006) will change shape as the model grows, and nothing yet says how.
  - A (ASSUMED, correct if wrong): a `schema_version` integer inside the document from
    the first commit, with forward-only migrations run on read and the migrated document
    written back. Cheap now, and retrofitting a version field onto documents already on
    disk means guessing which shape each one is.
- **Q78.** `P1` `ASSUMED` **Local HTTP security posture.** Q46 settled "no auth, bound to
  localhost", but a localhost HTTP server is reachable by **any** process on the
  machine and, via DNS rebinding, by a web page the user happens to visit.
  - A (ASSUMED, correct if wrong): bind to `127.0.0.1` only, validate the `Origin`
    header and reject cross-origin requests, no wildcard CORS, and validate uploads by
    decoding them (dimension and size caps) rather than trusting the declared type.
    Nothing sensitive is stored and no secrets exist in the MVP, so this is about not
    being trivially drivable by a hostile web page, not about protecting data.
- **Q79.** `P1` `ASSUMED` **When the two surfaces conflict, who wins?** Q18 mandated
  parity but never said what happens when a capability is awkward on one surface.
  - A (ASSUMED, correct if wrong): the **core operation** is the arbiter. A capability is
    defined as an op first; if it cannot be expressed as an op with both a CLI verb and a
    UI control, it is not built. Neither surface gets to win, because neither surface
    owns anything.
- **Q80.** `P1` `ASSUMED` **What happens when the worker is unavailable or crashes
  mid-import?** ADR-0005 makes the worker a separate container.
  - A (ASSUMED, correct if wrong): the job moves to `failed` with a diagnostic message
    and is retryable; the score is left untouched (an import is one op, ADR-0003, so a
    failed import commits nothing). The API stays fully functional without the worker —
    every non-import feature keeps working, which the milestone split in Q76 would make
    more than a theoretical property.
- **Q81.** `P1` `ASSUMED` **Are exported artefacts cached?** ADR-0016 says an instrument
  part "stores nothing", but ADR-0006 puts exported PDFs in the `BlobStore`. Read
  literally those conflict. Found in the adversarial pass.
  - A (ASSUMED, correct if wrong): exports are **generated on demand and cached** in the
    `BlobStore` keyed by `(score version, format, instrument)`. A version bump invalidates
    implicitly, so there is no invalidation logic to get wrong. The two ADRs are
    reconciled by the distinction that matters: **no score variant is ever stored**, but a
    rendered artefact may be cached. Recorded in `PLAN.md` §Implementation decisions.
  - **Amended (V3a, 2026-07-31):** the mechanism survived intact and the key grew. It is
    `(score version, document digest, instrument, paper, font, format)`, scoped by score id.
    Everything above still holds — generated on demand, cached, **no invalidation logic
    anywhere** — under one rule that the original key did not quite satisfy: *anything that
    changes the bytes is in the key.*
    - **The digest closes a hole this answer had.** Deleting a score destroys its log, and
      `score.create` takes a client-supplied id — so a new chart under a reused id starts
      again at version 1, and id-plus-version is not unique over time. The second chart was
      served the first one's PDF. Found by a test written against the literal key, not by
      re-reading this answer. The digest adds no invalidation: it makes the key name the exact
      bytes it stands for, and a serialisation change would cost a miss, never wrong bytes.
    - **Paper and font are here for the reason `instrument` was in from the start** — a
      component left out until something varies it makes that slice a cache-key migration.
      This answer predates ADR-0030, which makes the engraved face the reader's choice *per
      render* rather than a build-time constant; Q38 makes the paper one. An export endpoint
      that could only emit A4-Bravura would have contradicted both.

## Coverage

One row per checklist category, so a skipped category would be visible.

| Category | Covered by |
|----------|-----------|
| Primary user and actors | Q18, Q79 |
| Scope boundary | Q5, Q7, Q8, Q30, Q34, Q69, Q76 — and `PLAN.md` §Scope |
| Data model and identity | Q13, Q25, Q31, Q32, Q33, Q35, Q62 |
| State and storage | Q19, Q22, Q61, Q66, Q67, Q81 |
| Concurrency and conflict | Q1, Q21, Q47 |
| Interfaces and contracts | Q2, Q6, Q23, Q24, Q49, Q63, Q68 |
| Failure behaviour | Q28, Q33, Q56, Q80 |
| External dependencies | Q11, Q12, Q52, Q64, Q71, Q73, Q74, Q75 — register in ADR-0027 |
| Runtime and deployment | Q43, Q44, Q59, Q65, Q72, Q73 |
| Measurable success | Q14, Q17, Q41, Q42 |
| Security and secrets | Q46, Q78 |
| Versioning and migration | Q68, Q77 |
| *Domain:* rendering and layout correctness | Q12, Q36, Q38, Q39, Q57, Q58 |
| *Domain:* music theory correctness | Q9, Q10, Q60 |
| *Domain:* recognition quality and correction | Q3, Q16, Q26, Q27, Q29, Q53, Q54, Q55 |
