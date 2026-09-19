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

Open the printed URL. Pick a corpus image or upload a real photo, then pick a stage tab:

**Stage 1 — layout detection.** Two views, toggled in the Input panel:

- **final** (default) — the staves/barlines and matched chordBand `layout.detect_layout` actually
  produces, after clustering + matching: the geometry the real pipeline uses.
- **raw** — every individual detection before clustering, exactly as the model emits it (drag the
  score threshold to explore). Noisier by design — this is the view that surfaced KAN-1510/KAN-1511
  below.

A legend of checkboxes above the image toggles each class on/off; a table below the image lists
every visible detection's *true* pixel coordinates (a box drawn on the image is clamped to the page
bounds first — belt-and-braces; indah's overlay container itself now clips, see below — and the table
still shows you the unclamped truth and flags which boxes were clamped).

**Stage 2a — melody recogniser.** A "Staff #" stepper picks one detected staff at a time; three
sub-stage tabs show exactly what that staff's crop went through — **Crop** (the exact full-system
crop box `stage2a._crop_box` reconstructed), **Model input + predictions** (that crop resized to the
model's fixed 128px height — what the CRNN actually saw — with the decoded notes/rests **overlaid
directly on it**: one dot per token at its predicted position, 🔵 note / 🔴 rest, hover for
pitch/duration; the same data as a table underneath for reading several at once), and **Raw columns**
(the per-column CTC argmax stream, run-length encoded so blank gaps between symbols stay visible).
All of it reuses the exact internal functions `recognize_staff` calls in the real pipeline
(`_crop_box`/`_model_input`/`_run_columns`/`_ctc_collapse`/`_emit_objects`), refactored out of what
used to be one opaque `_decode_crop` specifically so this viewer (and any future caller) can see each
sub-stage independently, with zero behaviour change (covered by `tests/test_bespoke.py`).

**Stage 2b — chord band recogniser.** The same ladder over a "Band #" stepper (only staves with a
matched `chordBand` detection appear): **Band crop** (the padded, detected box `chords._band_bounds`
computes — the post-V17e-fix window), **Model input + predictions** (resized to 32px height, with
each segmented chord **overlaid as a box** — hover for its text + confidence, plus the same rows as a
table underneath), and **Raw characters** (the collapsed character stream, separator kept, each with
its own confidence). If this model dir has no baked chord pair (`chord.onnx`/`chord-vocab.json`), the
tab says so plainly instead of erroring — the same graceful-degrade contract `chords.load_chords`
documents for the real pipeline.

Both overlays place their markers by **fraction of the crop**, not absolute pixels: a decoded token's
position (Stage 2a) or a segmented chord's column span (Stage 2b) is already relative to the crop the
model actually saw, and the model input is that same crop uniformly rescaled (aspect preserved) — so
the fraction is identical whether you compute it against the original crop or the resized model input,
no separate coordinate mapping needed. Stage 2a uses `points` (always hover-only in indah, so a dozen
notes in a bar don't turn into overlapping permanent text); Stage 2b uses `boxes` with
`label_mode="hover"` (indah's newer alternative to the always-on label `ov-label` span) for the same
reason. Point/box fractions are still clamped to `[0, 1]` as a defensive belt-and-braces, though
indah's overlay container itself now clips overflow (see the indah#78 update below).

**Deliberately out of scope for Stage 2b (KAN-1506):** whether the V5 grammar corrector
(`packages/music`) would accept a decoded chord as legal or flag it as an `Annotation`. That's
TypeScript-side logic; bridging Python devtools to Node is its own decision, deferred to Milestone D
(KAN-1508) along with every other TS-side stage, so this viewer only ever shows what Stage 2b itself
decoded — pixels to text, nothing more.

**Ground-truth diffing (KAN-1507).** `pnpm eval --dump-corpus` now writes a `<name>.truth.json`
sidecar next to every dumped image — the `Score` it was rendered from, plus Stage-1 page boxes and
per-system note/chord labels, all read straight off `layout()` the same way `scripts/eval.ts`
already does for training corpora (`extractPageBoxes`/`extractSystemLabels`/`extractSystemChords`
in `packages/synth`; see that file's `TruthSidecar` doc comment for the exact shape). When the
picked input is a corpus sample with a sidecar present, every stage shows predicted vs. truth:

- **Stage 1** gets a "🎯 Show ground truth" toggle that overlays the truth boxes on the same image,
  always in a single dark colour (`TRUTH_COLOR`) regardless of class — "colour = predicted, black =
  truth" reads at a glance without a second legend — hover a truth box for its class, same
  `label_mode="hover"` convention as Stage 2a/2b. The counts line below the image also gets a
  ground-truth row. **The truth boxes are read off the *undistorted* render** (same technique V16a's
  own detector-training corpus uses, and for the same reason: geometric degradation — perspective,
  not photometric — moves pixels, so a box computed before it drifts from the final image). The
  sidecar's `geometryExact` flag says whether that drift applies (`false` for light/medium/heavy,
  `true` for clean); the counts line surfaces a caveat when it does. Sequence-level truth (notes,
  chords) is unaffected either way — only pixel positions drift under perspective.
- **Stage 2a/2b** each get a fourth sub-stage tab, "Predicted vs. truth": the predicted sequence
  (note/rest tokens, or chord text) aligned against the matching truth system's tokens/chords with
  `difflib.SequenceMatcher` — a positional diff, not the V5 grammar corrector (out of scope, same as
  Milestone B) — so a match, a substitution, and a one-sided extra/missing entry are each their own
  row, plus a one-line summary count above the table.

An uploaded real photo, or a corpus image dumped before this milestone, simply has no sidecar —
every truth-dependent view degrades to Milestone B's predictions-only view (checked directly: no
crash, an explicit "no ground truth" message on Stage 2a/2b, the Stage 1 toggle and ground-truth
count line just don't appear).

**Map — TypeScript-side stages (KAN-1508).** A fourth top-level tab shows `mapOmrToScore`, the V5
grammar corrector, and Stage-3 beat mapping running for real — `indah` is Python-only and these are
real TypeScript (`packages/model`/`packages/music`) this viewer must show running for real, never a
Python reimplementation that could drift from the actual mapper. The bridge is
`scripts/omr-viz-bridge.ts` (a `pnpm omr-viz-bridge <OmrDocument.json>` CLI, dev-only, not part of
the product runtime), run as a subprocess: for the current image,
`sibei_omr.engines.bespoke.recognize` — the exact function the real worker calls for `--engine
bespoke` — produces a real `OmrDocument` (re-running Stage 1+2a over every staff, not just the one a
Stage 2a/2b tab happens to have picked, plus Stage 2b; ~1-2s, memoized per image like everything else
here), which is written to a scratch file and handed to the bridge. The bridge runs `mapOmrToScore`
twice (with and without the corrector) plus every raw chord-band token through `correctChord`
directly, and prints the result as JSON. Three sub-stage tabs:

- **Bar/onset assignment** — `mapOmrToScore` with no corrector (the V11 result): every bar's
  notes/rests with their assigned onset and pitch, before the grammar corrector or Stage 3 ever run.
- **Grammar corrector** — every raw band token's text next to what `correctChord` (ADR-0011) made of
  it: the canonical chord spelling, or "kept as annotation" when the text is not a legal chord. Token
  level, independent of which bar (or whether any bar) it ends up attached to.
- **Stage 3 + final chords** — `mapOmrToScore` with the corrector injected: the real import result,
  each chord/annotation at the onset Stage 3 beat-mapped it to (Q71), flagged where low-confidence.

A reactive one-line text strip above the tabs mirrors `docs/omr-pipeline.md`'s mermaid diagram, the
active top-level tab's stage(s) bolded — "current stage highlighted" without a second visual
component, since indah's `Card` has no per-instance highlight prop to drive from the active tab
index. A subprocess failure (the bridge's own stderr, or `OmrMappingError`'s text on a no-staff
image) surfaces as a plain note in the panel, not a crash — verified by forcing both the success and
failure paths.

## Findings logged from using it (not fixed here — tracked on the board)

- **KAN-1510 — Stage-1 box regression is imprecise for `staff`/`chordBand`.** On a 3-image
  spot-check, raw detections went out of the page's pixel bounds 79% of the time for `staff` and 44%
  for `chordBand` (`barline`: 0%). Downstream clustering already resolves this into the correct staff
  count for the pipeline's own purposes, but the regression itself is worth fixing at the source.
- **KAN-1511 — wide-object NMS doesn't fully collapse duplicate `staff`/`chordBand` detections.**
  Visible directly in the "raw" view: two peaks along a wide object's heatmap ridge can have too
  little box overlap for per-box IoU-NMS to merge them. Not currently breaking the pipeline (the
  same downstream clustering absorbs it), but fragile.
- **KAN-1520 — an image switch can transiently surface a Stage 1/2a `ValueError` toast.** Uploading a
  real photo shortly after another selection occasionally raises `ValueError: operands could not be
  broadcast together with shapes (...)` from `bespoke_layout.detect_layout`/`stage2a.recognize_staff`
  — reproduced on the plain Stage 1 tab alone (Milestone D's Map tab is not involved). Not
  deterministic per image: the same photo that errored on one upload succeeded cleanly, with
  genuinely different recognised content, on a later attempt with the reactive state given time to
  settle — the signature of a race between the image signal updating and a dependent computation
  reading a stale array size, not a fixed per-photo defect. Retrying (or reloading) works around it;
  not chased further here since it is pre-existing Stage 1/2a code Milestone D does not touch.

## Milestones (EPIC-228 on the Pandan board)

- **A (KAN-1505): Stage 1.** Done.
- **B (KAN-1506): Stage 2a + Stage 2b panels.** Done — a per-staff/per-band stepper,
  each with three sub-stage tabs (crop, model input **with predictions overlaid**, raw CTC stream),
  reusing the exact internal functions (not the HTTP wire format). Explicitly does not show whether
  the grammar corrector would accept a decoded chord — that's Milestone D's call.
- **C (KAN-1507, this slice): ground-truth diffing.** Done — `pnpm eval --dump-corpus` writes a
  `<name>.truth.json` sidecar per image, and every stage shows predicted vs. truth side by side when
  one is present (a Stage-1 box overlay toggle; a fourth "Predicted vs. truth" sub-stage tab on
  Stage 2a/2b). See "Ground-truth diffing" above.
- **D (KAN-1508, this slice): the pipeline map + TypeScript-stage panels.** Done — a fourth "Map —
  TS-side stages" tab (`mapOmrToScore`, the grammar corrector, Stage-3 beat mapping) via a small
  `scripts/omr-viz-bridge.ts` subprocess bridge, and a reactive pipeline-map text strip mirroring
  `docs/omr-pipeline.md`'s diagram. See "Map — TypeScript-side stages" above.

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
  this tool). Three related things in the same code region: `boxes` had no hover-only label option
  (`points` already got a native `title` attribute; `boxes` didn't); `.ov-box`/`.ov-point` both had
  `pointer-events: none`, which may have made even that existing `title` a no-op; and `.overlay-wrap`
  had no `overflow: hidden`, so an out-of-range box — or even an in-bounds box near the top edge, whose
  label sits *above* it — could render past the image into the surrounding page. Milestone A worked
  around this by clamping box geometry in Python before handing it to `ImageOverlay`, and by not
  passing `label` at all (a separate table showed the detail instead).

  **Fixed upstream since Milestone A.** `ImageOverlay` now takes `label_mode: "always" | "hover"`
  (`"hover"` shows a box's label/score as a native `title` tooltip instead of the always-on `.ov-label`
  span), `.overlay-wrap` now sets `overflow: hidden`, and `.ov-box--hover`/`.ov-point` re-enable
  `pointer-events` so the tooltip is actually reachable. Milestone B (KAN-1506) is the first thing here
  to rely on the fix directly: Stage 2a's note/rest points and Stage 2b's chord boxes both use hover
  labels instead of Milestone A's clamp-and-omit workaround (the fractions are still clamped to
  `[0, 1]` too, belt-and-braces, but the container's own clipping is now the real fix).

Not a gap (checked, then ruled out): payload cost of showing several full-resolution pages at once —
the picker shows one image at a time reactively, so a page load is ~100–150 KB, not a problem.
