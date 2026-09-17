# sibei-score — agent brief

A local-only jazz lead sheet notation app: single staff, chord symbols above it, four bars to a
line, editable from a browser or a CLI and exportable as a printable PDF.

**Trust the code over these docs.** Where they disagree, the code is right and this file is
stale — fix it, in the same PR that made it stale.

## Status

**V1–V8 are done and v0.1 is complete; v0.2 (import) is now complete — V9, V10, V11, V12, V13 and V14 have all landed.** V8 was undo/redo, the MusicXML codec, library delete + duplicate, export wiring + toggle, the migration fixture, serving the built UI, the container and the v0.1 docs (V8a–V8i). **V9 is the oemer coordinate spike (ADR-0023) and it passed its gate: oemer's note/barline pixel coordinates are reachable in-process, so v0.2 proceeds without vendoring a fork.** The spike is Python in a new top-level `worker/` (outside the pnpm workspace, ADR-0005), standalone and not in CI; its output schema is model-owned (`packages/model/src/omr.ts`) and the V9 tests validate a committed real dump. **V10 is the worker, offline and in a job:** the V9 spike is promoted into a real recogniser (`worker/sibei_omr/recognize.py`) behind an HTTP worker (`worker/sibei_omr/server.py`), and the API side records an import as a durable **job** (ADR-0001) — an upload validated by decoding at the boundary (ADR-0029), stored in the BlobStore, enqueued, and run by a background runner that calls the worker across a `WorkerClient` port (ADR-0005) and stores the raw `OmrDocument`. A failed import records a diagnostic, is retryable, and commits nothing (Q80); the API is fully functional with the worker stopped. The worker is a second compose container with weights baked + checksummed at build time (ADR-0024, offline) and CPU-only as the floor with an opt-in GPU image (ADR-0025). **Mapping the recognised objects onto a `Score` via `score.import` is V11, not V10** — a succeeded V10 job carries the raw objects and creates no score. **V12 is the evaluation harness (R6, ADR-0020):** a new dev-only `packages/synth` (a deliberate ADR-0031 exception to the no-Node rule — a build-time tool, guarded out of every shipped bundle by `tests/arch`) generates plausible lead sheets, renders + degrades them into photos behind the `@sibei/synth/imaging` subpath (native `@resvg/resvg-js` + `sharp`, kept off the fast layer), and scores a recogniser against the ground truth by LCS/Levenshtein alignment; `make eval` / `pnpm eval` print the table and append `eval/history.jsonl`, with the recogniser an injected `Predict` seam so the same harness scores oemer now and v0.3's bespoke engine later. `packages/synth` is built a slice ahead of SLICES V15 on purpose, so v0.3 extends it. See `docs/eval.md` and the SLICES V12 note. **V13 reads chords from the photo (R5, completes the import pipeline):** the worker schema gains `bandTokens` (`OMR_SCHEMA_VERSION` 1→2) — raw chord-band OCR text with pixel boxes; a pure-TS step in `mapOmrToScore` snaps each token to a legal chord with the **V5 grammar corrector** (injected, since `model` can't import `music`, ADR-0011), **beat-maps** it to the note/onset at or before its box (stage 3, Q71), or keeps it as a flagged `Annotation` (Q56), carrying OCR confidence and flags into the model (ADR-0019); the worker crops the band and runs **PaddleOCR** (`worker/sibei_omr/band_ocr.py`, ADR-0027). V13 also pulls v0.3's **engine-selection seam forward** (`worker/sibei_omr/engines/{oemer,heuristic}`, chosen by `--engine`/`$SIBEI_OMR_ENGINE`, oemer the default): the **heuristic engine** is OpenCV-only, low-RAM **dev/test scaffolding** — NOT the trained V15/V16 bespoke model, and it earns no default swap (decided on the V12 harness, ADR-0020/0031) — so the whole flow and `make eval` run on a small host where oemer OOMs; it lifted chordF1 from 0 to 0.100 there. Rehearsal letters and sections are still **not detected** (ADR-0021); the oemer chord baseline (the ADR-0011 stage-2 target) and the PaddleOCR+oemer image build are deferred to a bigger host. Confidence shows in `sbscore show` as `Cmaj7!62` on flagged import chords (ADR-0009 stays lossy otherwise). See the SLICES V13 note and `worker/README.md`. See the ADR-0023 status update, `worker/README.md`, and `agent_docs/server.md` (the import job section).
`SLICES.md` is the plan of record and
carries per-slice history; `agent_docs/history.md` records how each slice was actually cut. What
exists: the score model, the layout engine, our own engraver, the server-side PDF path, the store,
the op log and applier, the `/v1/` API, the CLI with its text projection, export from the store, an
SSE change stream, a browser that opens a chart, edits it, and repaints live when something else
does, from V5 the chord grammar (`packages/music`: parse, format, the OCR corrector), the
`chord.set`/`chord.rm` ops, jazz chord typography through the engraver (`Δ`, `ø`, stacked
alterations), and chord editing on both surfaces, from V6 the enharmonic spelling engine
(`model/spelling.ts`), the `transpose` op, instrument parts as a render-time view
(`music/part.ts` — the browser previews them too), per-object spelling **pins** on notes and chords
(`spellingPinned`, schema v2), and all three on both surfaces (`sbscore transpose --to`,
`export --for`, `--spell`, and their browser controls in the score view), and from V7 **structure**:
sections and rehearsal letters, repeat/double/final barlines, and 1st/2nd endings — the
`section.set|rm`, `barline.set` and `ending.set|rm` ops (all targeting a whole-bar `bar12` address),
their `sbscore section|barline|repeat|ending` verbs, and the browser Structure panel reached by
clicking a bar. The layout has broken lines at real sections and the engraver drawn every barline
kind since V1 (ADR-0026); V7 was the write path and the surfaces, not the rendering. From V8a
**undo/redo** by replay of the append-only op log (ADR-0003): `undo`/`redo` *control* operations
resolved by `replayLog`, the `POST /v1/scores/:id/undo|redo` routes, `sbscore undo|redo`, and ctrl-Z
/ ctrl-shift-Z in the score view — an agent `batch` undoing as one unit. From V8b the **MusicXML
codec** (`packages/codec`): `scoreToMusicXml`/`musicXmlToScore` for single-voice lead sheets, with
its own dependency-free XML reader and a round-trip whose every lossy case is named in a test. From
V8d **MusicXML export is wired**: `GET …/export?format=musicxml` (a codec at the edge, not a render —
it ignores paper/font, honours `--for` via `writtenPart`, cached like the PDF) and `sbscore export
--musicxml`, and from V8e a **PDF | MusicXML toggle** in the score view's Export rail (the
SegmentedControl the rail already uses for face and paper). Still booked: **MusicXML import** (a
verb/button — pairs with v0.2's upload boundary). From V8c the **library** gained **delete** and
**duplicate** on both surfaces: `sbscore duplicate` and the row's Duplicate/Delete controls (delete
asks first — it destroys the log). Duplicate is a copy with a *fresh* history, built on `score.import`
— one operation carrying a whole document (ADR-0003), server-only (never the client `/ops` route, so
ADR-0008's anti-mangling guarantee holds), which v0.2's OMR import will reuse. From V8g the API can
**serve the built browser itself** — an fs-free `AssetSource` port (`packages/api/src/http/static.ts`)
fed by a reader in the CLI (`static-assets.ts`), turned on by `sbscore serve --ui DIR` (or `SBSCORE_UI`)
and off by default so Vite still serves the app in development; files are served last, after every
`/v1/` route, so nothing shadows the API. From V8h the app **ships as a container**: a `Dockerfile` and
`compose.yaml` run `sbscore serve --ui` on `127.0.0.1:8080` with a named volume for the SQLite library
and its blobs. `Api.listen(port, host?)` now takes a bind address (default `127.0.0.1`, unchanged for
every existing caller); `sbscore serve` exposes it as `--host`/`SBSCORE_HOST` and the container sets
`0.0.0.0`, while the compose file publishes to the host's loopback only — the ADR-0029 amendment that
separates the *bind* address from the *publish* address (`docs/adr/0029`, `docs/hosting.md`). From V8i
the **v0.1 docs** are current: the README (install both ways, the offline claim stated plainly), the
full CLI reference (`docs/cli.md`), and the hosted direction (`docs/hosting.md`). From V9 the **oemer
coordinate spike** (ADR-0023) has proven oemer's pixel coordinates reachable in-process: a standalone
Python spike in a top-level `worker/` (`worker/sibei_omr/spike.py`) dumps every detected
`Staff`/`NoteHead`/`NoteGroup`/`Barline`/`Rest` with coordinates to JSON, validated against the
model-owned schema (`packages/model/src/omr.ts`, `OmrDocument`). From V10 the **worker is real and
in a job**: `worker/sibei_omr/{recognize,server}.py`, and on the Node side the `JobStore` port and its
SQLite adapter (`packages/api/src/store/{jobs,sqlite-jobs}.ts`, the import_jobs table), the upload
boundary (`imports/upload.ts`), the `WorkerClient` port (`imports/worker-client.ts`), the runner
(`imports/runner.ts`), the job SSE bus/stream, and the `/v1/imports` routes. From V11 an import
**becomes an editable draft**: a pure, framework-free **mapper** (`packages/model/src/omr-map.ts`,
`mapOmrToScore`) turns the recognised objects into a `Score` — systems from the collapsed staff grid,
bars from deduplicated barlines, notes/rests by x-order with sequential onsets, pitch from staff
geometry (treble), per-bar metric flags (ADR-0013), low-confidence flags (ADR-0019), pages joined in
order (Q26); the runner maps → lands it through the new server-only `Applier.import` (folds one
`score.import` like `duplicate`) → fills `job.scoreId`; `POST /v1/imports` accepts several images as
`multipart/form-data`; and `sbscore import <file>...` plus a **library import affordance** both land
(Q79). The mapper defaults key/time and produces no clef/ties/triplets: **the `OmrDocument` schema does
not carry them** (nor does the worker emit them), so their detection is deferred — a documented
deviation from ADR-0021, since it needs the worker + schema + a real-oemer fixture. (That fixture was
unproducible on the V11 build host — no Docker/registry there — but **not** on all hosts: V12 built and
ran the worker image where access exists; oemer's real block is RAM, ~7 GB, which OOM-kills it on a
small machine. See the SLICES V12 note.) **V14 completes v0.2 — correcting a parse.** An OMR draft is
now fixed against its own photo from both surfaces (ADR-0019). The source is retained and reachable:
`JobReader.getByScoreId` (a store lookup, not a `Score`-schema change) plus `GET
/v1/imports/:jobId/images/:index` (V14a), surfaced as `GET /v1/scores/:id/source` (`{jobId, imageCount}`,
always 200) behind the browser's `SourcePane.svelte` split-pane (V14b) — the scans were validated at the
ADR-0029 upload boundary and re-parse writes no new blob. The engraver washes a metrically-invalid bar
rose (`INVALID_BAR_FILL`, ADR-0013) and a low-confidence flagged object yellow (`FLAGGED_OBJECT_FILL`,
ADR-0019) in `packages/engrave` (the `reviewChart` fixture), through the one byte-identical render path
(ADR-0014/0015) (V14c). `reviewSummary().hasSections` drives a `NO_SECTIONS_ADVISORY` on both surfaces —
import never detects sections and the four-bar layout depends on them (ADR-0021/0015) — with a
flag-parity test pinning `sbscore show`'s `!` flags equal to the browser's (V14d). And `POST
/v1/scores/:id/reparse` (`ImportService.reparse`, `sbscore reparse <id> [--engine oemer|heuristic]`, a UI
Re-parse control) re-runs OMR over the kept scans with no re-upload — `getByScoreId` → runner (ADR-0005)
→ the server-only `Applier.import` (ADR-0003/0008) → a **new** draft, the original untouched; the engine
is threaded end-to-end (job table schema v3→v4) with a `422 unsupported-engine` (V14e). The V12
human-time ship gate is written into `docs/eval.md` as a repeatable procedure, but the run itself is
**deferred** — its 32-bar fixture is not yet committed (V14f). Still **not built yet:** MusicXML import;
clef/key/time/tie/triplet **detection** (worker + a further `OMR_SCHEMA_VERSION` bump + fixture); and
title/composer OCR (Q37 — V13 added the OCR pipeline, but it still needs a `ScoreMeta` review field to
flag a low-confidence title). V13's chord-band OCR and stage-3 beat mapping are **done**. Don't assume a
module exists because a plan mentions it.

**v0.3 (the bespoke recogniser, ADR-0031) is under way — V15, V16 and V17a–V17e have landed; the default
stays `oemer` until V17f scores oemer's widened-corpus baseline and re-decides the swap — and V17e found
that a Stage 2b crop-alignment gap needs closing first (below).** V16 built the
**Stage-1 layout detector** and completed the
fully-staged bespoke engine. **V16a** (`packages/synth/src/page-boxes.ts`, `pnpm dump:v16a`) reads
page-level object boxes — staff, barline, chordBand, title — straight off `layout()` (no detection), the
load-bearing corpus shipped before any model. **V16b** trained a small CenterNet-style centre-point
detector (`worker/training/detect_*.py`, `detect.onnx` ~1.8 MB) on a RunPod GPU; the heatmap head avoids
the anchor/NMS + dynamic-output machinery that fought the V15b ONNX export, decoding is host-side numpy
(peak-pick + per-class IoU-NMS), and a **/8** grid (finer than /16) separates the short adjacent
staff/band rows and lifted **staff recall 0.66 → 0.92** (barline F1 0.99). **V16c** made
`engines/bespoke` a **package** — `layout.py` (Stage 1: detect + assemble detections into staves +
barlines, a *system* being a cluster at one staff-centre y, its height from the reliable barlines),
`stage2a.py` (the unchanged V15c crop+CRNN), `assemble.py` (both → one `OmrDocument`) — dropping the
borrowed heuristic staff-finder. **V16d/e** scored it on the harness and decided the swap: bespoke-full
noteF1 **~0.85 flat across clean/light/medium/heavy** (V15c's staff-finder-borrowing bespoke collapsed to
0.20–0.38 on degraded pages), **~0.4 sec/page**, **~290 MB peak RSS** (oemer ~7 GB) — it wins notes,
bars, speed and RAM decisively, but reads **no chords** (V17), so the default stays `oemer` (flipping now
would drop chord recognition); V16 *earns* the notes/bars/RAM swap and V17 completes it. `peakMB` was
**not** made a schema field (disproportionate v2→v3 blast radius; measured directly). oemer's
widened-corpus note-baseline (KAN-1426) is deferred to V17's real swap. See the SLICES V16 note,
`docs/eval.md`, `docs/omr-pipeline.md` and `worker/README.md`. **V15a/b/c** remain the Stage-2a
foundation: V15a is the
synthetic Stage-2a corpus (`packages/synth`: per-system crops + a 512-class flat-semantic CTC vocab,
`pnpm dump:v15a`); V15b trained the first bespoke model (a small CRNN+CTC in `worker/training/`, GPU via
`rp train-relay`, ~99.8% held-out token accuracy; `out/v15b/model.onnx`, gitignored). **V15c wired it
into the worker as a third engine** (`worker/sibei_omr/engines/bespoke.py`, `--engine bespoke`): it
reuses the heuristic staff-finder for staves+barlines (Stage-1 is V16), crops each system to the
measured full-system proportions, runs the ONNX model on onnxruntime CPU, and emits a schema-valid
`OmrDocument` whose notehead **x comes from the CTC column index** and whose pitch/duration come from the
decoded flat-semantic token (the notehead y is synthesised on the detected staff, round-tripping through
`pitchFromGeometry`). `model.onnx` + `vocab.json` (`pnpm export:v15c-vocab`) are baked + checksummed
(`bespoke_weights.py`, ADR-0024), never committed. It **beats the heuristic engine ~7× on clean-synthetic
noteF1 (0.868 vs 0.120) at ~0.3 sec/page and ~176 MB peak RAM** (oemer: ~7 GB, ~13 min) — the ADR-0031
footprint escape — and by eye tracks the melody on real photos (`worker/visualize_bespoke.py` →
`out/v15c-real-preds/`). (This V15c note describes the interim staff-finder-borrowing engine; V16c replaced its Stage-1 with the
trained detector.) **V17 is the bespoke chord band and the swap.** **V17a** added domain randomisation to
the corpus (music face, chord symbology via `ChordStyle` in `packages/engrave/src/text.ts`, and vendored
typefaces). **V17b** made rich chromatic chords the default and built the chord-band corpus (`pnpm
dump:v17b` → band crops + a **character-level** CTC vocab — id 0 blank, id 1 `<sep>`, ~38 glyph chars,
complete-by-construction). **V17c** trained the **Stage-2b** chord-band recogniser (`worker/training/
chord_train.py`, a small CRNN+CTC sized for the ~46:1 band strip — five height-pool blocks not six),
**held-out chord accuracy 0.968** (char-acc 0.987, band-exact 0.909) on a RunPod A40; `chord.onnx` +
`chord-vocab.json` (`pnpm export:v17c-vocab`) are baked + checksummed (`bespoke_weights.py`, ADR-0024),
never committed. **V17d wired Stage 2b in**: `engines/bespoke/chords.py` reads the **detected**
`chordBand` box Stage 1 matches to each staff (`layout.py`'s new `_match_chordband`, over the same
group-null attachment window `mapOmrToScore`'s `bandAttachesTo` uses) rather than a staff-relative
geometric approximation — cropping the exact box V17b's corpus trained on, the same "train and
inference crop alike" discipline Stage 2a settled at V15c. Each chord's pixel box comes from the CTC
columns its characters occupy (mirroring Stage 2a's column→x), split into distinct chords on the
vocabulary's separator class; `assemble.assemble` now returns a fifth value (the raw Stage-1 staves,
carrying `chordBand` internally, never emitted on the wire) so `chords.py` can read it. A missing chord
pair still degrades gracefully to an empty band (a Stage-1+2a-only model dir, every pre-V17d fixture,
keeps recognising notes). **V17e scored the whole bespoke import (notes + chords) on the V12 harness**
and found two distinct problems, not one, behind an initial chordF1 of 0.011-0.080: (1) `_match_chordband`'s
window (`_BAND_SPACES_ABOVE`) was calibrated too tight — the detector's own chordBand boxes centred
6.5-7.4 staff-spaces above the staff, just outside the old 6.0-space window, so band recall was only
0.42; widened to 8.0 (fixed in V17e, band recall 1.00, also bumped the mirrored `BAND_SPACES` fallback in
`packages/model/src/omr-map.ts`), this alone moved chordF1 to 0.124-0.134. (2) **Still open:** even with
every band matched, Stage 2b was trained on the corpus's *ground-truth* band boxes, not Stage-1-*detected*
ones, and a chord band is tight and densely packed enough that a modest detector localisation error clips
real characters — so end-to-end chordF1 (~0.13) remains far below `chord.onnx`'s own 0.968 held-out floor.
noteF1/validBars/RAM/speed are otherwise consistent with V16 (noteF1 unchanged at ~0.85; peak RAM ~307 MB,
~0.64 sec/page with Stage 2b's added onnxruntime calls) — this is a chord-band-specific gap, not a
Stage-1 regression. **V17e's verdict: not yet ready to inform V17f's swap call** — retraining Stage 2b on
detector-predicted (or jittered) boxes is the recommended next step before V17f re-runs the oemer baseline
and decides the swap. See "The whole bespoke import scored end to end (V17e result)" in `docs/eval.md`.
Still deferred in v0.3: **closing V17e's crop-alignment gap**, **oemer's widened-corpus note-baseline
(KAN-1426) + the default-engine swap (V17f)** — plus a rendered clef/key head in the corpus (a real-photo
OOD region) and triplets/tuplets (excluded at the generator + vocab + schema, though the runtime `Score`
model already has `Tuplet`). See the SLICES V15/V16/V17 notes, `docs/eval.md` and `worker/README.md`.

## Layout

```
packages/
  model      score types, tick arithmetic, pitch, derived metric validity
  music      the chord grammar: parse/format chord symbols to structure, and the OCR corrector
  codec      MusicXML at the edges (ADR-0004): score <-> MusicXML string, single-voice. Own XML reader
  layout     score -> engine-independent positions: the four-bar grid
  engrave    layout positions -> glyphs, ours, off a SMuFL font's own metrics
  pdf        server-side render: SVG -> PDF, metadata pinned. No DOM
  api        the server side: store, op log + applier, /v1/ routes, export, the change bus.
             `@sibei/api` is the port; `@sibei/api/sqlite` is the adapter
  cli        the `sbscore` binary — an HTTP client of the API, never a second write path
  ui         the browser: Svelte 5 + Vite. Renders through layout + engrave, never @sibei/pdf
  fixtures   hand-authored scores: nasty-chart, every-glyph, long-form (spills to page 2), untitled,
             aaba-chart (V7's structure demo: pickup, rehearsal letters, a repeat with 1st/2nd endings)
  synth      DEV-ONLY (V12): synthetic corpus + OMR eval metrics. May use Node APIs (ADR-0031 exception),
             never in a product bundle. `@sibei/synth` is the pure core; `@sibei/synth/imaging` the
             native (resvg+sharp) render+degrade half
worker/      the OMR worker (Python, ADR-0005) — OUTSIDE the pnpm workspace, its own pyproject/venv.
             V10: the recogniser (`sibei_omr/recognize.py`) behind an HTTP server (`server.py`); the V9
             spike (`spike.py`) is a CLI over the same core. V13: an engine-selection seam
             (`sibei_omr/engines/{oemer,heuristic,bespoke}`, chosen by `--engine`/`$SIBEI_OMR_ENGINE`) —
             the `heuristic` engine is OpenCV-only, low-RAM dev/test scaffolding (v0.3's V15 seam pulled
             forward, ADR-0031); the `bespoke` engine (V16) is a **package** (`engines/bespoke/`) — the
             fully-staged trained recogniser: `layout.py` (Stage-1 detector, `detect.onnx`, V16b) +
             `stage2a.py` (the V15c CRNN+CTC, `model.onnx`) + `assemble.py`, on onnxruntime CPU (three
             artifacts baked+checksummed via `bespoke_weights.py`, vocab from `pnpm export:v15c-vocab`,
             eyeball Stage-1 with `visualize_detect.py`, Stage-2a with `visualize_bespoke.py`); and chord-band OCR
             (`sibei_omr/band_ocr.py`, PaddleOCR, ADR-0027) shared by the engines. A Dockerfile bakes
             weights; GPU is Dockerfile.gpu. Never touches the store; stateless; its own `unittest`s,
             not in the Node CI
tools/runpod/ DEV/BUILD-TIME ONLY (ADR-0032): a guardrail shell wrapper (`rp`) that runs the
             EXISTING worker container on a rented RunPod pod to produce an artifact (an oemer eval
             number now, checkpoints later) and guarantees teardown. OUTSIDE the pnpm workspace, no
             Node deps, imports no `packages/*`; never a product runtime dependency, never in a bundle.
             The `RUNPOD_API_KEY` lives only in the gitignored `tools/runpod/.env` and `rp` reads it
             BY REFERENCE. **Never read `tools/runpod/.env` (or the key value) into context, and never
             cat/echo/print/log it** — handle it blind, machine-to-machine only (ADR-0032)
tests/
  unit/  integration/  e2e/  arch/     no infra: the `fast` layer
  store/  api/  cli/  browser/         need a real store, socket or browser: the `infra` layer
  imaging/  eval/                       V12: native resvg+sharp / the eval harness — also `infra`
  snapshots/                           committed .svg files
  fixtures/                            committed inputs: a v1 score for migration, omr/ spike dumps, eval/real/
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
pnpm eval                  # score OMR accuracy (needs the worker; --engine fixture to smoke). docs/eval.md
pnpm proof                 # look at the engraving — see agent_docs/proofing.md
pnpm vendor:fonts          # regenerate the vendored font slices (needs network)
pnpm hooks:install         # point git at .githooks (do this once per clone)
```

## Hard invariants

Breaking one of these breaks a decision of record. Ask before deviating from any ADR.

- `model`, `music`, `layout` and `codec` are plain TypeScript: **no framework, no Node APIs.**
  `layout` runs in the browser *and* server-side (ADR-0005, ADR-0022). Enforced by the compiler
  (`"types": []`, no DOM lib) and by `tests/arch`. **`packages/synth` is the one sanctioned exception**
  (ADR-0031): a build-time data/eval tool that may use Node APIs, and in return `tests/arch` forbids any
  product-runtime package (`pdf`/`api`/`cli`/`ui`) from importing it — it must never enter a bundle.
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
  control yet. (V8e gave `export --musicxml` its rail toggle, so export format now has both.) (V6's `transpose`, part export and `--spell` pins, and V7c's structure panel —
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
| `SLICES.md` | The planned slices in build order (v0.1–v0.3, V1–V17), each with its own test plan |
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
| `agent_docs/v15-training-notes.md` | The V15 bespoke-training retrospective: what worked, what broke, how (read before any v0.3 training/RunPod work) |
| `docs/omr-pipeline.md` | The staged OMR pipeline drawn end to end — the map of stages 1/2a/2b/3, the engine seam, and what's built vs deferred (touching import, the worker, or the bespoke recogniser) |
| `docs/eval.md` | The OMR evaluation harness: the metrics, the three-dimensional gate (accuracy + speed + RAM), and how to run it |
| `docs/cli.md` | The user-facing `sbscore` CLI reference: running it (from source or the container), every verb with examples, addresses, export, concurrency, exit codes. `sbscore --help` is the live source of truth |
| `docs/hosting.md` | Planning the hosted, multi-user future: the target architecture, the local→hosted seam map, and best practices (a direction doc, not a decision of record — the ADRs it cites are) |

MIT licensed — see `LICENSE`.
