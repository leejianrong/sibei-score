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

Open the printed URL. Pick a corpus image or upload a real photo; the Stage 1 panel overlays
detected `staff`/`barline`/`chordBand`/`title` boxes live as you drag the score threshold.

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

Not a gap (checked, then ruled out): payload cost of showing several full-resolution pages at once —
the picker shows one image at a time reactively, so a page load is ~100–150 KB, not a problem.
