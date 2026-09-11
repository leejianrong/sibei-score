# Build history and the roadmap

The short status is in `AGENTS.md`; `SLICES.md` is the plan of record. This file keeps the
per-slice history — how each slice was actually cut, and what each cut taught — and the table of
things deliberately not built yet.

## How the slices were actually cut

**V11 turns a recognised import into an editable draft — the first slice that interprets a
note.** Where V10 stored raw `OmrDocument` objects and left `scoreId` null, V11 maps them onto a
`Score` and lands it. The whole of the interpretation is a **pure, framework-free mapper**,
`packages/model/src/omr-map.ts` (`mapOmrToScore`), which is the point worth stating: it consumes the
worker's output schema and produces the runtime score, both owned by `model`, so it is fully
fast-layer testable against the committed real dump (`tests/fixtures/omr/aaba-chart.omr.json`) —
**no oemer, no weights, no Docker** — which is exactly why V11's core is buildable and verifiable in
an environment where the worker container is not (`tests/unit/omr-map.test.ts`). The mapper collapses
oemer's per-track staff grid into systems (using the per-staff extents and *ignoring* the unreliable
`zones` layer — a V9 finding made load-bearing), segments each system into bars from deduplicated
barlines trimmed to the note span (barlines over-fire on stems, a V9 finding), orders notes and rests
by x into sequential onsets, reads pitch from staff geometry against a treble clef, computes per-bar
metric validity and stores-and-flags an invalid bar rather than repairing it (ADR-0013), flags a
notehead oemer doubts or whose duration it could not name (ADR-0019), and joins several pages in order
(Q26).

Landing it goes through the one writer, not around it. The runner holds a `JobWriter`, never a
`ScoreWriter` (ADR-0003), so a new **server-only `Applier.import(owner, document)`** was added — the
exact shape of V8c's `duplicate`, folding one `score.import` op and calling `store.create` — and the
runner is handed it narrowed to `ScoreImporter` (just `import`). So the pipeline is recognise → map →
import → set `job.scoreId`, all synchronous and adjacent at the end of the job so there is never a
succeeded job without a score nor a score without a job. The transport gained multi-image support
(`POST /v1/imports` now accepts `multipart/form-data`, a hand-rolled parser beside the upload
boundary, keeping V10's single-raw path working), and both surfaces got their control (Q79):
`sbscore import <file>...` (submit, poll to terminal, print the draft's id) and a **library import
affordance** (a file picker that submits, shows a spinner while the job runs, then opens the new
score). A no-staff image fails cleanly (ADR-0018/Q28) rather than making an empty score; the source
images are retained in the BlobStore forever (ADR-0019).

**The schema-gap decision — confirmed with the maintainer — is "default and flag, defer detection".**
The `OmrDocument` the worker emits carries staves, noteheads, note groups, single barlines and rests
and **nothing else**: it omits clef, key-signature accidentals and time signature (build-plan item 2's
"key and time signature"), *and* ties and tuplets/triplets (item 2's "ties, triplets"). `recognize.py`
computes clef/sfn layers internally but never registers them in the schema. So V11 maps what is
actually emitted, defaults key = C major / time = 4/4, reads pitch against an assumed treble clef, and
produces no ties or triplets — each a flagged gap the human closes (ADR-0019). Detecting any of these
needs the worker **and** the schema (`OMR_SCHEMA_VERSION`) extended **and a fresh real-oemer fixture**,
none producible in this environment (no oemer; the org egress policy blocks every container registry,
so no base image is pullable and Docker builds fail). Shipping untested Python plus a fabricated
fixture would be worse than the honest gap, so this is deferred to a host with oemer/registry access
and recorded as a **documented deviation from ADR-0021** ("key and time signature … detected on
import"). Build-plan item 1 (explicit deskew/perspective/crop/contrast) is likewise deferred:
`recognize.py` already deskews and dewarps through oemer, and explicit OpenCV crop/contrast is
untestable here.

**Two plan/code discrepancies, surfaced rather than worked around (AGENTS.md's rule).** First, the
E2E clause *"undoing an import leaves an empty score"* conflicts with ADR-0003's undo *floor*. V11
lands an import as a **new** score (the create-from-document path, identical to `duplicate`), whose
single `score.import` op is the floor — so undo is a no-op there and the score is removed by *delete*,
not undo, exactly as a duplicate behaves. The replay-from-empty property still holds exactly (asserted
in `tests/api/applier.test.ts`). Reading the clause literally would mean importing into a pre-existing
empty score, which is not the V10 job model (a job creates a new score and fills `scoreId`). Second,
`sbscore import` deliberately has no `--title`/`--composer`: OCR of title/composer (Q37) needs the OCR
the pipeline does not run until V13, and `ScoreMeta` carries no review field to flag them
low-confidence — so the title defaults empty (KAN-594) and the user sets it with `meta set` after.

The live-worker demo (a real phone photo → the oemer container → a PDF) cannot run here for the
registry reason above; it is verified against the committed dump, an API test with a stub worker, a
CLI test with a stub worker, and a **browser E2E with a fake in-process worker** (a canned
`OmrDocument` over the worker HTTP seam, so `sbscore serve --worker` drives the whole job pipeline —
upload, map, land, open — without oemer). The real-container run is deferred to a host with registry
access.

**V10 is the worker, offline and in a job — the plumbing that turns the V9 spike into
infrastructure, without yet interpreting a note.** OMR is a job, not a request (ADR-0001):
the API validates an uploaded scan by *decoding* it at the boundary (ADR-0029: real byte and
dimension caps, format from content, a dimension-bomb refused by reading the header not the
pixels), stores it in the BlobStore, records a durable job, and a background runner hands the
image to the Python worker across a `WorkerClient` port (ADR-0005) and stores the raw
`OmrDocument` it gets back. The worker is the V9 spike promoted: its stage sequence moved into
`worker/sibei_omr/recognize.py`, wrapped in a stdlib HTTP server (`server.py`) that the API
calls; `spike.py` stays as a CLI over the same core.

The slice boundary is the thing worth stating, because the plan's own wording invites the
wrong read. V10's demo is *"see the raw recognised objects stored"*, and V11's build plan is
*"map oemer's objects to the score model"* + *"import as one op carrying the whole document"*.
So **V10 lands the objects and creates no score** — the `score.import` mapping is V11's named
deliverable, and pulling it forward would blur two slices whose whole point is that recognition
and interpretation are separable. A succeeded V10 job carries an `OmrDocument` and a null
`scoreId`; the column exists so V11 fills it without a migration.

The job is durable because the API is stateless (ADR-0001 #7): the `import_jobs` table (a new
`JobStore` port and its SQLite adapter — the third, argued-for file in the store seam) survives
a restart, and the runner recovers an interrupted `running` job into a retryable `failed` on
the next boot. A failed import records a diagnostic, is retryable, and commits nothing (Q80) —
trivially true here, since no score is written until V11. The API is fully functional with the
worker stopped: a submit still enqueues and then fails cleanly with a diagnostic, and with no
worker configured at all `POST /v1/imports` is a 503 while every other route is untouched.
Progress rides an SSE job stream that is the change stream's sibling (V4a) — same halves, same
`payload-is-a-nudge-to-re-read` contract, `{jobId,status}` instead of `{scoreId,version}`.

Two things drifted from the plan on contact with the code, and are recorded rather than worked
around. First, the **GPU "compose profile"** the plan (and ADR-0025) names cannot be a compose
`profiles:` key: a profile *adds* a service, it cannot swap this one's image (a CUDA base,
onnxruntime-gpu) without duplicating it and leaving two workers for the API to choose between.
The honest mechanism is an **override file** — `docker compose -f compose.yaml -f
compose.gpu.yaml up` — which keeps the `worker` service name (so `SBSCORE_WORKER_URL` is
unchanged) and replaces only the build and the GPU reservation. It still changes speed only,
never output, because it runs the same baked ONNX weights through the CUDA provider. Second,
**the image build and the networking-disabled offline test need a container host** (Docker or
Podman), which was not available where this was cut; the Dockerfiles and compose are authored
and reviewed, and the offline property is true *by construction* — the image fetches weights
only at build time (ADR-0024), `fetch_weights.py` checksum-verifies them, and nothing in the
worker's runtime path opens a socket except the one the API calls — but that is asserted by
reading the build, not yet by running `--network none`. The worker README says so plainly.

The runtime pins the V9 spike measured are carried into the image verbatim (extending
ADR-0024): oemer 0.1.8, onnxruntime 1.16.3 (newer refuses oemer's ConvTranspose nodes),
opencv 4.10 (opencv 5 breaks staffline extraction), numpy 1.26 — the CPU wheel, since CPU is
the floor (ADR-0025). No new dependency entered the Node side: the upload boundary hand-rolls
PNG/JPEG header parsing rather than pull an image library into the package ADR-0006 keeps thin,
the same habit as the codec's own XML reader.

**V9 is the oemer coordinate spike, and it passed its gate: the coordinates are reachable
in-process, so v0.2 proceeds to V10 without vendoring a fork of oemer.** This is the first
v0.2 slice and, by ADR-0023's design, a spike rather than a feature — the riskiest unknown
in the project (Q71: are oemer's note and barline pixel coordinates actually reachable?)
confronted before any import code is written. The answer is yes, and cheaply: oemer's own
`ete.py:extract` stashes the recognised `Staff`/`NoteHead`/`NoteGroup`/`Barline`/`Rest`
objects in a process-global `layers` registry before it builds MusicXML, and each carries a
`.bbox` reachable by plain attribute access. The spike (`worker/sibei_omr/spike.py`) copies
that stage sequence, stops before the lossy MusicXML step, and dumps every object with its
coordinates to JSON. The fork contingency — the thing this slice existed to decide on —
stays unused.

The worker is a new top-level `worker/` (not `packages/`), deliberately outside the pnpm
workspace: it is Python, isolated from the Node runtime (ADR-0005), with its own
`pyproject.toml` and virtualenv. It never touches the store; the spike is a standalone
script, not wired into the API, and does not run in CI. What runs in CI is TypeScript: the
worker's output schema is owned by the `model` package (`packages/model/src/omr.ts`,
`OmrDocument` + `parseOmrDocument`), and the V9 test plan's three checks run against the
committed real dump (`tests/fixtures/omr/aaba-chart.omr.json`) as pure fast-layer tests —
the same pattern as the committed SVG snapshots.

The spike earned its keep the way a spike should: by finding what the plan could not. The
plan describes intent, and three things had drifted by contact with the code. oemer's last
release is **0.1.8 (Nov 2024)**, not the "0.1.7 / Oct 2023" the ADRs cite. And the runtime
that reads the weights has to be pinned alongside them (extending ADR-0024's pinned-weights
rule): onnxruntime ≥ ~1.19 refuses oemer's bundled ConvTranspose nodes, opencv 5 changed
`HoughLinesP`'s return shape and breaks staffline extraction, and both drag numpy across the
1→2 line — so the CPU floor (ADR-0025) is not just "install the CPU wheel" but a specific
compatible set (oemer 0.1.8 / onnxruntime 1.16.3 / opencv 4.10 / numpy 1.26). Two findings
were booked for V10 rather than fixed here: oemer's `zones` layer covered only the top of the
page, so stage 3 should use per-staff extents; and the `staffs` layer repeats each system
across a track grid the consumer must collapse. Neither touches the gate. There are no real
lead-sheet photos in the repo — the fixtures are hand-authored JSON scores — so the spike
ran on a rendered `aaba-chart` page (a genuine printed chart, ADR-0018's input class, and
ADR-0020's synthetic-first strategy); the honest cost is that the CPU wall-clock is a
best-case lower bound and real-photo robustness is unexercised, which is V10's evaluation
work. Details and the wall-clock figures: `worker/README.md`.

**V8 is undo, MusicXML, the library, the container and the docs, cut into vertical sub-slices the
way V2–V7 were.** The verification pass paid off the way V7's did: the read surface over the op log
(`ScoreReader.operations`) and the library `delete` already existed, the `batch` column has grouped
undoable units since V2c, and migration-on-read has been real since V6d — so undo owed no schema
change and no new store method.

| | Delivers | State |
|---|---|---|
| V8a | Undo/redo by replay of the op log — control ops, `POST …/undo\|redo`, `sbscore undo\|redo`, ctrl-Z | **done** |
| V8b | The `codec` package: MusicXML export + import, single-voice, every lossy case named | **done** |
| V8c | Library delete + duplicate (design-first UI) | **done** |
| V8d | MusicXML export wired: `GET …/export?format=musicxml`, `sbscore export --musicxml` | **done** |
| V8e | The PDF \| MusicXML export-format toggle in the score view (design-first) | **done** |
| V8f | A migration fixture through every schema version | **done** |
| V8g | Serving the built UI from the API — the `AssetSource` port, `sbscore serve --ui` | **done** |
| V8h | The container: Dockerfile + compose + a persistent volume; the ADR-0029 bind amendment | **done** |
| V8i | v0.1 docs: install (both ways), the CLI reference, the offline claim | **done** |

The sub-slices ran ahead of the up-front V8d–V8f labels once the codec split export from its UI and
the migration fixture came late; the rows above are the cut as it actually landed, newest work last.

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

**V8i is the v0.1 docs, and it completes v0.1.** The README had drifted to a V1–V4 status ("chords,
transposition, and photo import are planned") while V5–V8 had all landed; it now states v0.1 as
complete, documents both ways to run the app (the container via `docker compose up`, and from source
for the CLI and development), and states the offline claim plainly — no network at runtime, no
telemetry, no account, loopback-only publish. The full CLI reference moved to `docs/cli.md` (every
verb group with examples, the address forms, export, concurrency and the exit-code contract), with
`sbscore --help` named as the live source of truth so the two do not drift. Docs-only slice; no code.
With it, everything SLICES.md's V8 planned is done and v0.1 is finished — the roadmap now points at
v0.2 (MusicXML import, then the OMR pipeline) and, further out, the hosted transition in
`docs/hosting.md`.

**V8h ships the container, and its one real decision was a flaw in ADR-0029's wording.** The rule said
&ldquo;bind `127.0.0.1`, never `0.0.0.0`, including in the compose file&rdquo; — but Docker forwards a
published port to the container's *bridge* interface, so a loopback-only process is unreachable from the
host and the container looks dead. The fix (an amendment recorded in `docs/adr/0029`, put to the user
before writing code because it touches an ADR): separate the **bind** address from the **publish**
address. `Api.listen(port, host?)` gained a host parameter that **defaults to `127.0.0.1`**, so every
existing caller binds loopback exactly as before; `sbscore serve` exposes it as `--host`/`SBSCORE_HOST`;
the container sets `0.0.0.0` so the forwarded port reaches the process, and `compose.yaml` publishes
`127.0.0.1:8080:8080` — LAN-unreachability now lives on the publish address, where a container can
actually enforce it, and the Origin/Host guards are untouched (the browser still reaches it as
`localhost`). The image runs the app from source (Node 22 type-stripping / tsx, no compile step — honest
for v0.1; production hardening is booked in `docs/hosting.md`) and serves the built UI via V8g's `--ui`.
A named volume holds the SQLite library and its blobs under `/data`. The registry was unreachable from
the build sandbox so the image build itself was not run here, but the runtime path the container uses —
bind `0.0.0.0`, same-origin UI, `/v1/health`, data persistence across a restart — was smoke-tested
directly through the CLI, and `docker compose config` confirms the loopback-only publish. Residual,
noted in the ADR: `0.0.0.0` also reaches other containers on the same Docker network; a dedicated
compose network closes it.

**V8g lets the API serve the built browser, which is the container's prerequisite, not the container.**
A shipped image has no Vite, so the API serves the bundle itself — and serving the app and its `/v1/`
calls from one origin is exactly what ADR-0029's Origin/Host guards assume. The constraint that shaped
it is ADR-0006's blob seam: `packages/api` may not name the filesystem (`blob-seam.test.ts` allows the
one directory blob adapter and nothing else), so the bytes arrive through an `AssetSource` **port** —
`asset(path) -> {bytes, contentType} | null` — and the fs-backed reader lives in `packages/cli`
(`static-assets.ts`), where naming a directory is a legitimate argument. The reader hoists the whole
bundle into a `Map` at startup, so a request is a lookup that never touches disk and a crafted
`/../../etc/passwd` has nothing to traverse: it hits a key or misses. Routing serves a file **last** —
only a GET, only once every `/v1/` route declined, and never for a `/v1/` path — so a file can never
shadow the API, proven by a test whose fake bundle *would* answer `/v1/health` and is never consulted
there. There is **no SPA fallback**: the browser routes on the URL hash (`App.svelte`), so the only
paths that reach the server are `/` and the hashed assets, and a real path miss is an honest 404 rather
than a masked one. Off by default (`serve` without `--ui` is unchanged, for Vite-in-dev); `sbscore
serve --ui DIR` (or `SBSCORE_UI`) turns it on and fails fast on a directory that is missing or has no
`index.html`, the same stance `--data` takes. Smoke-tested against a real `pnpm --filter @sibei/ui
build`. The container that sets `--ui` is the next slice; it still owes the ADR-0029 bind question
(a published port needs a `0.0.0.0` bind inside the container, which the loopback-only rule forbids).

**V8f is the migration fixture test, and it earned its keep by catching a real bug.** ADR-0028's
standing tax is a fixture carried through every schema step; `tests/fixtures/score-v1.json` is a whole
chart as a v1 build wrote it — notes, a rest, chords, a section, a repeat with an ending, and no
`spellingPinned` anywhere. Migrating it surfaced that the v1→v2 step backfilled `spellingPinned` onto
chords but **not onto notes**, though V6d added the field to both; the old test never saw it because
its v1 fixture had a chord and no notes. Fixed in `migrate.ts` (the step now backfills note items too;
rests carry no pin) and guarded by the fixture's deep-equal assertion — the "every bug becomes a test
first" rule, met by the test that found it. The new `tests/fixtures/` is committed data like
`snapshots/`, so `suite-layers` learned to treat it as data rather than an unrun test layer.

**V8e gave the export rail a PDF | MusicXML toggle — design-first, and reuse.** It is the same
`SegmentedControl` the rail already uses for face and paper (an approved pattern, so the mockup was a
faithful reuse rather than net-new design), placed in the Export group above the download button.
`format` joined `ExportChoice`, so `exportUrl`/`exportRoute` thread it through and the printed route
matches the file — "one choice, not two". MusicXML doesn't change the sheet on screen (it is not a
render), so paper and face stay live and a note says the file ignores them. Verified against the
mockup with `export-musicxml.png`; a browser E2E fetches the export link and confirms the bytes are
MusicXML. This closes V8d's booked UI gap; MusicXML *import* remains the only booked codec surface.

**V8d wired MusicXML export — V8b's booked debt, minus the UI.** The codec landed pure at V8b; V8d
reached it from `GET …/export?format=musicxml` and `sbscore export --musicxml`. In the exporter it is
a codec at the edge, not a render: it branches to `scoreToMusicXml` rather than `@sibei/pdf`, so paper
and font do not touch the bytes (they stay in the cache key, harmless over-keying). `writtenPart` runs
first, so a transposing part exports transposed — the same instrument view a PDF part uses. The one
gotcha was the CLI arg parser: `--musicxml` had to join the `SWITCHES` set or it read as an option
wanting a value. The UI export-format toggle is deferred to a design-first sub-slice rather than
shipped as a fourth rail control without a mockup; MusicXML *import* waits for v0.2's upload boundary.

**V8c is the library's delete and duplicate, and it was design-first.** Delete's backend already
existed (V2's `ScoreLibrary.delete`, the DELETE route, `sbscore rm`) — the slice was the browser
control and duplicate. Duplicate needed a decision (put to the user): a copy with a *fresh* history,
so ctrl-Z on a just-made duplicate does nothing. That is built on `score.import` — one operation
carrying a whole document, ADR-0003's sanctioned create-from-document, which v0.2's OMR import will
reuse. `score.import` is a real `Operation` (it folds like a create) but kept off the client `/ops`
route: `apply` refuses it, because accepting a whole document from a client is the document-patch
anti-pattern ADR-0008 rejected. It reaches the log only through the `duplicate` lifecycle call, which
goes through the applier (unlike delete, it *creates* a log rather than destroying one). The copy's
id is minted `<id>-copy`. The UI followed the design-first rule: a published mockup approved first,
then implementation with `pnpm screenshots` grown by `library-actions.png` and
`library-delete-confirm.png` checked against it — the row became a grid (a `<button>` cannot hold the
action buttons), actions stay quiet until hover, and delete asks inline because it is irreversible.

**V8b is the MusicXML codec, and it is a pure engine landed before its wiring — the V6a pattern.**
`packages/codec` is `scoreToMusicXml` and `musicXmlToScore` for a single-voice lead sheet, plus its
own dependency-free XML reader/writer. The reader is hand-written on purpose: `tests/arch` lets a
framework-free package depend only on the other framework-free `@sibei/*` packages, so an XML library
was never an option — the same "own the seam" call the engraver made. The round-trip preserves
everything MusicXML can express (asserted as a musical signature of the nasty and AABA fixtures) and
every lossy case is named in a test (ADR-0004): app ids, a note's accidental *display* mode,
`spellingPinned`, confidence/review, the style line, a section's free-text name, a section with no
letter, and chord text the grammar cannot parse. The chord round-trips exactly even so, because the
verbatim symbol rides in the `<kind text>` attribute while the structured `<root>`/`<kind>` is what a
third-party app renders. Chord onsets ride in a harmony `<offset>` from the measure start, so a chord
off the beat lands where it was. **Not wired to a surface yet** — no `export --musicxml`, no import
verb or button — which is booked debt, not an oversight: V6a landed the spelling engine the same way,
pure first and wired in the sub-slices after, and a package's own PR is a poor place for dead surface
code. The one bug the tests caught before it shipped: a single-bar `start-stop` ending left the
importer's open-ending state set, so every bar after it read as `continue` — the fixture round-trip
is what found it.

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
| Online "standards lookup" import backend (web / curated DB) | needs an ADR first | Q82. Could seed or repair hard imports from a known tune's changes, but it is a runtime network dependency (ADR-0001/0024) and copyrighted-chart exposure (ADR-0020). Open, undecided — an opt-in online backend behind the ADR-0019 draft seam if ever accepted |
| Online VLM "cloud assist" recognition backend | needs an ADR first | Q83. May be the only thing that copes with the "Shaw 'Nuff" class (grand staves, prose, drums), but reverses ADR-0010's absolute "no vision-model path" and crosses offline (ADR-0024) and copyright/privacy (ADR-0020). Open, undecided — opt-in, off-by-default, core stays local |
| Our own local vision model + score-vision pipeline | needs an ADR first | Q84. Decompose a score into bars/phrases and recognise per-region, with object detection across every element class (bars, title, text markings, chords, rehearsal marks), trained on the ADR-0020 synthetic corpus. Local, so unlike Q83 it does NOT break offline (ADR-0001/0024) — but it reopens ADR-0010's "oemer over building one" and touches ADR-0011/0023. A large build; open, undecided |
