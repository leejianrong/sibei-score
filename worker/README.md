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
  recognize.py   the recogniser: one image path in, an OmrDocument dict out
  server.py      the HTTP server: POST /recognize (raw image bytes) -> OmrDocument JSON; GET /health
  spike.py       the V9 CLI: run the recogniser on a file, write the JSON + wall-clock line
```

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

V10 is the worker's **plumbing** — the offline worker, in a job, over HTTP. It does not
interpret what it recognises. Still ahead: mapping oemer's objects onto the score model and
landing them via `score.import` (V11), preprocessing (deskew/crop/contrast, V11), the
chord-band OCR and stage-3 beat mapping (V13), and the evaluation harness (V12). See
`SLICES.md` and `agent_docs/history.md`. A succeeded V10 job carries the raw `OmrDocument`
and nothing more.
