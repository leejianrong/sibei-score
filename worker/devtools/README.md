# OMR pipeline visualization (dev tooling, EPIC-228)

A qualitative viewer for the bespoke OMR engine's stages, built with
[indah](https://github.com/leejianrong/indah) — a reactive Python UI framework. **Dev-only**: never
imported by product code, never in CI, never baked into the shipped worker image (same posture as
`worker/visualize_detect.py`/`worker/visualize_bespoke.py` and `tools/runpod`, ADR-0005/0024).

Motivated by V17e (KAN-1485): most of the debugging that found the chordBand match-window bug and
the crop-alignment gap was done with one-off throwaway scripts dumping JSON to stdout. This replaces
that workflow with a persistent, reactive viewer — pick an image, see what each stage actually
produced.

**Scope (v1): the Python worker stages only** — Stage 1 (layout detection), Stage 2a (staff
recognizer), Stage 2b (chord band). The TypeScript-side stages (`mapOmrToScore`, the grammar
corrector, Stage-3 beat mapping) and the overall pipeline map are deferred (KAN-1508) — indah is
Python-only, and bridging to the Node side needs its own decision.

## Why its own dependency group

`indah` is under active development in a sibling checkout
(`/home/jianlee/projects/abang-ai/indah-python-ui`). `worker/devtools/omr_viz/` has its own
`pyproject.toml` and venv, entirely separate from `worker/pyproject.toml` — this tool must never
touch the shipped worker image's dependency list (ADR-0024's offline guarantee is only as strong as
that list is short). It imports `sibei_omr.engines.bespoke` directly via `sys.path`, not an editable
install of the `sibei-omr` package, so it never pulls in oemer or PaddleOCR.

## Running it

From the repo root, one command does the one-time setup (venv, indah, bespoke weights, a sample
corpus) and launches it:

```sh
make omr-viz
```

(`INDAH_PATH` defaults to the maintainer's local indah checkout; override with
`make omr-viz INDAH_PATH=/path/to/indah-python-ui` if yours lives elsewhere. Re-run `make omr-viz`
any time — setup is skipped once `.venv`/weights/corpus already exist.)

Or by hand:

```sh
cd worker/devtools/omr_viz
uv venv --python 3.11
uv pip install -e /home/jianlee/projects/abang-ai/indah-python-ui   # local dev checkout, not PyPI
uv pip install -e .

# Generate a small corpus to browse (from the repo root):
pnpm eval --dump-corpus out/viz-corpus --seeds 6 --bars 16

SIBEI_BESPOKE_MODEL_DIR=$PWD/../../../out/bespoke \
OMR_VIZ_CORPUS_DIR=$PWD/../../../out/viz-corpus \
  python app.py
```

Open the printed URL. Pick a corpus image or upload a real photo. Two views, toggled in the Input
panel:

- **final** (default) — the staves/barlines and matched chordBand `layout.detect_layout` actually
  produces, after clustering + matching: the geometry the real pipeline uses.
- **raw** — every individual detection before clustering, exactly as the model emits it (drag the
  score threshold to explore). Noisier by design — this is the view that surfaced KAN-1510/KAN-1511
  below.

A legend of checkboxes above the image toggles each class on/off; a table below the image lists
every visible detection's *true* pixel coordinates (a box drawn on the image is clamped to the page
bounds first — indah's overlay has no clipping of its own, leejianrong/indah#78 — so nothing bleeds
into the surrounding page, but the table still shows you the unclamped truth and flags which boxes
were clamped).

## Findings logged from using it (not fixed here — tracked on the board)

- **KAN-1510 — Stage-1 box regression is imprecise for `staff`/`chordBand`.** On a 3-image
  spot-check, raw detections went out of the page's pixel bounds 79% of the time for `staff` and 44%
  for `chordBand` (`barline`: 0%). Downstream clustering already resolves this into the correct staff
  count for the pipeline's own purposes, but the regression itself is worth fixing at the source.
- **KAN-1511 — wide-object NMS doesn't fully collapse duplicate `staff`/`chordBand` detections.**
  Visible directly in the "raw" view: two peaks along a wide object's heatmap ridge can have too
  little box overlap for per-box IoU-NMS to merge them. Not currently breaking the pipeline (the
  same downstream clustering absorbs it), but fragile.

## Milestones (EPIC-228 on the Pandan board)

- **A (KAN-1505, this slice): Stage 1.** Done.
- **B (KAN-1506): Stage 2a + Stage 2b panels** — per-crop images beside decoded
  notes/chords, reusing the exact internal functions (not the HTTP wire format).
- **C (KAN-1507): ground-truth diffing** — extend `pnpm eval --dump-corpus` to also
  write a `<name>.truth.json` sidecar, and show predicted-vs-truth side by side.
- **D (KAN-1508, deferred): the pipeline map + TypeScript-stage panels.**

## indah gaps found while building Milestone A

Filed on [leejianrong/indah](https://github.com/leejianrong/indah/issues):

- **The shell crashes silently on a malformed `navigator.language`.** A bundled minified dependency
  calls `new Intl.NumberFormat(navigator.language)` at module load with no fallback/try-catch;
  headless Chromium on this host reports `en-US@posix`, which `Intl` rejects (`RangeError: Invalid
  language tag`), and the whole app fails to mount (blank page, no error boundary) — even for an app
  using none of the components that need number formatting. Reproduced with a plain Playwright
  screenshot; fixed by forcing the browser context's locale to a valid tag (a workaround, not a fix).
- **No zoom/pan on `ImageOverlay`.** Our pages are ~1587×2245px and the region of interest (a
  30–80px chord band) is a small fraction of that; at any reasonable on-page display size it's too
  small to read. Confirmed absent from the current component set.
- **Boxes always show a permanent inline label, and out-of-range boxes/labels bleed outside the
  image** ([#78](https://github.com/leejianrong/indah/issues/78), found from real user feedback on
  this tool). Three related things in the same code region: `boxes` have no hover-only label option
  (`points` already get a native `title` attribute; `boxes` don't); `.ov-box`/`.ov-point` both have
  `pointer-events: none`, which may make even that existing `title` a no-op; and `.overlay-wrap` has
  no `overflow: hidden`, so an out-of-range box — or even an in-bounds box near the top edge, whose
  label sits *above* it — can render past the image into the surrounding page. Worked around here by
  clamping box geometry in Python before handing it to `ImageOverlay`, and by not passing `label` at
  all (a separate table shows the detail instead).

Not a gap (checked, then ruled out): payload cost of showing several full-resolution pages at once —
the picker shows one image at a time reactively, so a page load is ~100–150 KB, not a problem.
