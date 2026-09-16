# sibei-score OMR worker

Python owns oemer and (from V11) OCR, and nothing else. It receives an image and returns
raw musical objects with pixel coordinates; it never touches the score store and never
becomes a second write path (ADR-0005, ADR-0003). It is isolated from the Node/pnpm
workspace — its own toolchain, its own `pyproject.toml`, its own virtualenv — so the two
runtimes never entangle.

## What's here today: the V10 worker (and the V9 spike it grew from)

**V10 promotes the V9 coordinate spike into the real worker.** The recognition core — the
in-process oemer stage sequence, stopping before oemer's lossy MusicXML build so the pixel
coordinates survive — now lives in `sibei_omr/recognize.py`, and `sibei_omr/server.py` wraps
it in the HTTP seam the Node API calls across (ADR-0005). `sibei_omr/spike.py` remains as a
one-file CLI over the same core.

```
sibei_omr/
  recognize.py   the oemer recogniser: one image path in, an OmrDocument dict out
  server.py      the HTTP server: POST /recognize (raw image bytes) -> OmrDocument JSON; GET /health
  spike.py       the V9 CLI: run the recogniser on a file, write the JSON + wall-clock line
  engines/       the engine-selection seam (V13c): get_engine(name) -> {oemer, heuristic, bespoke}
    oemer.py       adapts recognize.py behind the seam (the default; weights baked, ADR-0024)
    heuristic.py   a dependency-light OpenCV engine, low RAM — runs where oemer is OOM-killed
    bespoke/       the trained, staged recogniser (V16, ADR-0031), CPU/low-RAM:
      layout.py      Stage 1 — the centre-point detector (detect.onnx, V16b): staves + barlines
      stage2a.py     Stage 2a — the CRNN+CTC melody recogniser (model.onnx, V15b)
      assemble.py    combine both stages into one OmrDocument
      detect_decode.py / detect_config.py   pure-numpy heatmap decode (mirrors worker/training)
```

## The engine seam and the heuristic engine (V13c)

The worker recognises with one of several **engines**, selected by `--engine` (or
`$SIBEI_OMR_ENGINE`, default `oemer`). Every engine emits the **same** `OmrDocument`
(`packages/model/src/omr.ts`), so the Node side — the `WorkerClient` port, the job runner,
`mapOmrToScore`, both surfaces — never learns which one ran (ADR-0005). This is v0.3's
engine-selection seam (SLICES V15, ADR-0031) pulled forward.

- **`oemer`** — the default, the only engine with weights baked in. Unchanged from V10.
- **`heuristic`** — OpenCV image processing only (no ML weights, no tensorflow/onnxruntime,
  low RAM), so it runs the whole photo → draft → PDF flow, and `make eval`, on a small host
  where oemer's ~7 GB model is OOM-killed (the V12 finding). It finds staves (projection +
  line grouping), barlines (tall vertical runs), and noteheads (blobs left after staff-line
  and stem removal); rhythm is not read (every head is a quarter, a draft the human corrects,
  ADR-0013/0019). **It is dev/test scaffolding and the seed of the bespoke direction, NOT the
  trained bespoke model V15/V16 will build, and it earns no default swap** — a swap is decided
  on the V12 harness (ADR-0020), never by fiat. It needs no new dependency (OpenCV + numpy are
  already the oemer pins) and no weights, so it is offline by construction.

- **`bespoke`** — the trained, **staged** recogniser (V16, ADR-0031), a `bespoke/` package, read on
  CPU via onnxruntime and sized for low RAM — the challenger that has to beat oemer on the harness to
  earn the default (it does **not** get the default by fiat, same rule as the heuristic engine).
  - **Stage 1 — the layout detector** (`layout.py`, `detect.onnx`, V16b): a small centre-point
    (CenterNet-style) detector finds the staves + barlines on the whole page. This **replaces the
    borrowed heuristic OpenCV staff-finder** V15c leaned on — the real-photo bottleneck (a phantom
    "staff" from the title, a missed low-contrast staff). A system is a cluster of detections at one
    staff-centre y; its height comes from the reliable barlines (a barline box spans the staff), its
    x-extent from the staff box. Bars are **not** detected — the mapper derives them from barline x +
    system breaks (ADR-0031).
  - **Stage 2a — the melody recogniser** (`stage2a.py`, `model.onnx` + `vocab.json`, V15b): crops each
    system the way training did (a full-system box: chord band + staff + descenders — measured
    proportions, so train and inference match), runs the CRNN, greedy-CTC-decodes, and emits
    noteheads/rests with **coordinates derived from the CTC column index** (ADR-0023/Q71 — stage-3
    chord beat-mapping rides on them).
  It reads notes only for now: the Stage-2b chord model is **trained and checksum-pinned** (V17c,
  `chord.onnx` — held-out chord accuracy 0.968), but the engine wires it into `bandTokens` in **V17d**,
  so the bespoke band is still empty until then. Five baked artifacts, checksum-verified
  (`bespoke_weights.py`, ADR-0024): `detect.onnx`, `model.onnx` + the matched `vocab.json` (regenerate
  with `pnpm export:v15c-vocab`), and `chord.onnx` + the matched `chord-vocab.json` (regenerate with
  `pnpm export:v17c-vocab`), found via `$SIBEI_BESPOKE_MODEL_DIR` (dev) or `/opt/sibei/bespoke` (image).
  onnxruntime is already an oemer dependency, so no new runtime dep; torch is training-only and never
  imported at inference.

### Getting the weights (ADR-0033)

The five artifacts are gitignored (`out/`): the `.onnx` come off nondeterministic GPU training runs (a
retrain is a *different* model, so its bytes are irreplaceable), the vocabs are regenerated by the TS
exporters. The pinned set is published as an immutable **GitHub Release** and pulled by checksum at
build/dev time — the `fetch_weights.py` pattern (for oemer) extended to our own models. `fetch_bespoke.py`
is the *fetch* half of `bespoke_weights.py`'s *verify* half; both read the same `ARTIFACTS` pins +
`RELEASE_TAG`, bumped together on a retrain. The download needs no auth (public repo):

```sh
cd worker
python fetch_bespoke.py --dir ../out/bespoke      # download + checksum-verify the current pinned set
python fetch_bespoke.py --dir ../out/bespoke --verify-only   # just check what's already there
```

Run the whole import stack against either non-default engine, no oemer container needed:

```sh
SIBEI_OMR_ENGINE=heuristic python -m sibei_omr.server     # serve the heuristic engine
pnpm eval --engine worker --url http://127.0.0.1:8000     # score it on the synthetic corpus

# The bespoke engine: fetch the pinned artifact set into one dir, then point the engine at it.
python fetch_bespoke.py --dir ../out/bespoke              # detect.onnx + model.onnx + vocab.json + chord.onnx + chord-vocab.json
SIBEI_BESPOKE_MODEL_DIR=$PWD/../out/bespoke \
  SIBEI_OMR_ENGINE=bespoke python -m sibei_omr.server
pnpm eval --engine worker --url http://127.0.0.1:8000
```

The Stage-2a recogniser beats the heuristic engine on notes decisively — on a clean synthetic corpus
(seeds 6, bars 16) noteF1 **0.868 vs 0.120** — because it reads rhythm *and* pitch where the heuristic
engine labels every head a quarter. Where V15c was bottlenecked on degraded/real images by the borrowed
OpenCV staff-finder, V16's trained Stage-1 detector now finds the staves page-wide (staff recall ~0.92
on held-out synthetic, and it localises the staves on real photos where the heuristic finder invents a
phantom title-staff). The full-pipeline accuracy-and-RAM comparison that decides the default swap is the
V16 harness run (`docs/eval.md`, ADR-0031).

## The chord band: PaddleOCR (V13d)

`sibei_omr/band_ocr.py` is the engine-neutral chord-band recogniser (ADR-0010 stage 1/2,
ADR-0027): it crops the strip above each staff, runs PaddleOCR over it, and returns the text
**verbatim** with each box mapped back to full-image coordinates — the space stage-3 beat mapping
needs (Q71). Both engines call it. The worker does **not** decide what is a chord; snapping to a
legal chord (the V5 grammar corrector, ADR-0011) or keeping it as a flagged annotation (Q56) is the
model's job in TypeScript (`mapOmrToScore`). The OCR is an injected seam, stubbed in the tests.

Two findings on contact with PaddleOCR 3.x:

- **`enable_mkldnn=False`** — paddle's oneDNN/PIR CPU path raised `ConvertPirAttribute2RuntimeAttribute`;
  disabling oneDNN routes around it (CPU is the floor anyway, ADR-0025).
- **No numpy split** — paddlepaddle 3.3.1 needs only `numpy>=1.21`, so it co-exists with oemer's
  `numpy==1.26.4`; both engines share one image.

**Offline (ADR-0024):** `fetch_weights.py` warms PaddleOCR's model cache at build time and the runtime
sets `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK`, so the container reads baked models and never probes the
network. Where PaddleOCR is absent, the engines degrade to an empty band and still import the melody.

**Measured end to end on an 8 GB host** (heuristic engine + PaddleOCR, no oemer): `pnpm eval --engine
worker` lifted `chordF1` from 0.000 to 0.100 on the synthetic corpus — the whole photo → chords flow
runs and chord accuracy is now a real, non-zero number. The **oemer** chord baseline (the one ADR-0011
stage 2 must beat) is measured on a bigger host, since oemer's ~7 GB model is OOM-killed here.

The API records an import as a **job** (ADR-0001), calls this worker, and lands the result;
the worker is stateless and holds no database. **CPU-only is the hard floor (ADR-0025)** —
the image uses the CPU `onnxruntime` wheel — and the GPU path is a separate, opt-in image
(`Dockerfile.gpu`) that changes speed, never output. **Offline is baked in (ADR-0024):** the
Docker image fetches and checksum-verifies every ONNX weight at build time, so a running
container never downloads a model and an import runs with networking disabled.

Below the V10 sections is the original V9 spike write-up (the gate result, the CPU
wall-clock, and the dependency-pinning findings), kept because those measurements are still
the reason the pins are what they are.

## Running the worker

### As a container (the real deployment)

The worker is the second container in the compose stack (`compose.yaml`, Q44). From the repo
root:

```sh
docker compose up --build            # builds the api and worker images, starts both
# app on http://127.0.0.1:8080; the api reaches the worker at http://worker:8000 internally
```

The worker image bakes the weights at build time (`fetch_weights.py`, checksum-verified), so
the build needs the network but the running container does not. GPU (opt-in, speed only):

```sh
docker compose -f compose.yaml -f compose.gpu.yaml up --build   # needs an NVIDIA GPU + toolkit
```

### Directly, in the venv (development)

```sh
cd worker
uv venv --python 3.11 && uv pip install -e .
python fetch_weights.py               # fetch the weights once (the image does this at build)
python -m sibei_omr.server            # serve on 0.0.0.0:8000 (SIBEI_OMR_HOST/PORT to change)
```

Then point the API at it: `pnpm sbscore serve --worker http://127.0.0.1:8000` (or
`SBSCORE_WORKER_URL`). Without a worker configured, the API runs fine and import is a 503
(Q80) — every other feature works.

### The worker's own tests

Standalone, like the rest of `worker/` (outside the Node CI, ADR-0005). They stub the
recogniser through `serve`'s injection seam, so they need neither oemer nor weights:

```sh
cd worker && python -m unittest discover -s tests
```

## What's here today: the V9 coordinate spike

V9 is the **oemer coordinate spike** (ADR-0023), the riskiest unknown in the project,
confronted before any import application code is written. The question it answers is Q71:
**are oemer's note and barline pixel coordinates actually reachable?** Stage 3 of the
import pipeline (ADR-0010) aligns recognised chord bounding boxes to note and barline pixel
X-coordinates — that is the whole reason oemer was chosen over an engine that emits only
MusicXML (which has no coordinates). If the coordinates cannot be reached, stage 3 as
designed cannot be built.

`sibei_omr/spike.py` runs oemer **in-process, as a library** on one raster image, reaches
its internal `Staff` / `NoteHead` / `NoteGroup` / `Barline` / `Rest` objects, and dumps
every one with its pixel coordinates and attributes to JSON. It also measures CPU
wall-clock, which ADR-0025 needs documented.

### The gate result

**Coordinates are reachable in-process, without a fork. Proceed to V10.** See
[the findings](#findings) and the status update on ADR-0023.

## Running it

The worker is deliberately outside the pnpm workspace, so set up its own environment:

```sh
cd worker

# 1. An isolated Python 3.11 environment (uv shown; python -m venv works too).
uv venv --python 3.11
uv pip install -e .            # installs oemer==0.1.8 and the pinned CPU deps

# 2. Fetch oemer's ONNX segmentation weights once (~104 MB, checksum-verified).
#    oemer downloads these on first run; V10 will bake them in at build time (ADR-0024).
python fetch_weights.py

# 3. Run the spike on an image of a printed lead sheet.
python -m sibei_omr.spike path/to/chart.png -o chart.omr.json
```

The output JSON conforms to the model-owned schema (`packages/model/src/omr.ts`,
`OmrDocument`), which is the contract across the language boundary (ADR-0005).

### There are no real photos in the repo

The repo's fixtures are hand-authored JSON scores, not images. The spike's committed
sample (`../tests/fixtures/omr/aaba-chart.omr.json`) was produced from a **rendered**
fixture: the `aaba-chart` engraving rasterised to a PNG through the repo's own
`scripts/preview.ts`. That is a genuine printed, engraved chart — the ADR-0018 input
class — and it matches ADR-0020's "primarily synthetic corpus" evaluation strategy.

A clean render is the *best case*: it has no skew, shadow, perspective or JPEG noise, so
the wall-clock below is a **lower bound** and coordinate robustness on real photographs is
not exercised here. Firming up the ADR-0025 number and stressing coordinate quality on
real input is V10 evaluation work (ADR-0020); 2–3 representative phone photos are the
input it wants.

## Findings

### Coordinate reachability — the gate

`oemer/ete.py`'s `extract()` runs the recognition stages and stashes their results in a
process-global registry, `oemer.layers`, before it builds MusicXML. The objects we need
are registered there:

| Layer | Objects | Coordinate field |
|-------|---------|------------------|
| `staffs` | `Staff` | `x_left`/`x_right`/`y_upper`/`y_lower`/`y_center` (computed properties) |
| `notes` | `NoteHead` | `.bbox` = `(x1, y1, x2, y2)` |
| `note_groups` | `NoteGroup` | `.bbox` |
| `barlines` | `Barline` | `.bbox` |
| `rests` | `Rest` | `.bbox` |

The spike replicates `extract()` up to those registrations, then reads them back — it stops
before the MusicXML build, the lossy step that discards coordinates. So the coordinates are
reachable **without vendoring a fork of oemer** (ADR-0023's contingency): the internals are
plain instance attributes, imported as a library. The one wrinkle — `extract()` is welded
to writing a `.musicxml` file, with no "run the stages and hand me the objects" seam — is
handled by copying the ~40-line stage sequence into the spike, not by forking.

### CPU wall-clock (ADR-0025)

CPU-only is confirmed as workable and measured. onnxruntime reports only
`['AzureExecutionProvider', 'CPUExecutionProvider']` in this environment — no CUDA — so
these numbers are genuinely CPU-only. Recognition only (segmentation + extraction):

| Chart (rendered page) | Coordinate space | Detected | CPU wall-clock |
|---|---|---|---|
| aaba-chart | 1612×2280 | 8 systems, 66 noteheads, 42 barlines, 0 rests | **321 s (5.4 min)** |
| nasty-chart | 1612×2280 | 61 noteheads, 25 barlines, 2 rests | **336 s (5.6 min)** |
| long-form | 1612×2280 | 99 noteheads, 32 barlines, 2 rests | **318 s (5.3 min)** |

The figures cluster tightly (318–336 s) even though the charts differ in density — long-form
detects the most yet times the fastest — because oemer normalises every image to ~3.67 MP
before recognition, so wall-clock tracks that fixed pixel budget rather than chart content or
source resolution. (Measured single-run, uncontended; a run sharing the CPU with the Node
test suite came in at 452 s — a caution that these are best-case, idle-machine figures.)

The image is normalised to ~3.67 megapixels before recognition
(`oemer/inference.py:resize_image`), so wall-clock is largely independent of the source
resolution. Peak resident memory was ~7 GB.

### Dependency pinning — a finding for V10 (ADR-0024)

- **oemer is pinned to 0.1.8** (2024-11-16), the last release. The ADRs cite "October
  2023 / 0.1.7"; that is stale (see the ADR-0023 status note) — 0.1.8 exists and is what
  the spike used. ADR-0023's reasoning (a quiet dependency, a fork always available under
  MIT) is unaffected.
- **onnxruntime must be pinned low.** The default dependency is `onnxruntime-gpu`; the CPU
  wheel is a drop-in for the ADR-0025 floor (oemer only does `import onnxruntime`). But
  onnxruntime ≥ ~1.19 tightened ONNX shape-inference and **refuses oemer's bundled
  ConvTranspose nodes** — `[ShapeInferenceError] Attribute pads must not contain negative
  values`. 1.16.3 (contemporaneous with oemer) loads them. **The runtime that reads the
  weights has to be pinned alongside the weights**, which extends ADR-0024's pinned-weights
  work to the inference runtime.
- **numpy is pinned < 2.** oemer predates the numpy 2 API removals, and onnxruntime 1.16.3
  is built against numpy 1.x.
- **Weights are fetched from GitHub release assets** (`BreezeWhite/oemer`, tag
  `checkpoints`), ~104 MB of ONNX, reachable in this environment. `fetch_weights.py`
  records their pinned SHA-256 — the seed for V10's baked-in, checksum-verified weights.

## Not built here

The worker recognises; it does not interpret. **V11 interpreted the objects entirely on the Node
side** — a succeeded job now maps its `OmrDocument`s onto a `Score` and lands it — without changing a
line of this worker, because the mapping is pure TypeScript over the worker's output schema
(`packages/model/src/omr-map.ts`). That is the seam working as designed (ADR-0005): the worker's
contract is the schema, and everything downstream of it is Node's.

Two things the plan booked for the worker are **deferred**, both because they cannot be built or
verified without oemer and a container registry. (That access was blocked on the host V9–V11 were built
on; it is **not** a standing project limitation — V12 built and ran this image on a host that has
Docker + registry access. What remains scarce there is RAM: oemer peaks ~7 GB, and on a small machine
recognition is OOM-killed, so a real fixture/baseline waits for a bigger host rather than for access.)

- **Emitting clef, key signature, time signature, ties and tuplets.** V11's mapper needs these but the
  `OmrDocument` schema (`packages/model/src/omr.ts`) does not carry them and `recognize.py` does not
  emit them (it computes clef/sfn layers internally, then drops them). Adding them is a coordinated
  change here **and** in the model schema (bump `OMR_SCHEMA_VERSION`) **and** a refreshed committed
  fixture — so V11 defaults key/time and produces no ties/triplets, a documented ADR-0021 deviation
  (see `SLICES.md` V11). This is the next worker task.
- **Explicit preprocessing** (build-plan item 1: deskew, perspective, crop-to-page, contrast, Q27).
  `recognize.py` already deskews and dewarps through oemer; explicit OpenCV crop/contrast is a small
  addition but untestable without running oemer, so it waits for a host that can.

The **evaluation harness (V12) has landed** — it scores this worker's output against synthetic ground
truth (`make eval`; `packages/synth`, `docs/eval.md`), and it is what v0.3's bespoke engine must beat
to earn the default (ADR-0031). Still ahead: the chord-band OCR and stage-3 beat mapping (V13, this
worker gains PaddleOCR). See `SLICES.md` and `agent_docs/history.md`.
