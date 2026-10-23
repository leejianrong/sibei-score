# ADR-0036: A real-corpus labelling studio and dataset strategy

- **Status:** Proposed — planning of record for v0.5 (KAN-1522). Not yet built. Part 3 and part 4's
  exporter are **amended 2026-10-23** (expressive labels; see the Amendment below).
- **Date:** 2026-09-19
- **Deciders:** Jian, in design discussion
- **Relates to:** [ADR-0005](0005-node-owns-api-python-omr-worker.md),
  [ADR-0018](0018-import-printed-raster-only.md),
  [ADR-0020](0020-omr-evaluation-strategy.md),
  [ADR-0024](0024-model-weights-baked-at-build-time.md),
  [ADR-0031](0031-bespoke-recogniser.md),
  [ADR-0033](0033-bespoke-model-artifact-store.md),
  [ADR-0038](0038-full-notation-is-the-long-term-direction.md)

## Context

Every model trained so far (V15b, V16b, V17c) trains on `packages/synth`'s synthetic corpus —
plausible charts rendered and degraded by our own engraver, with ground truth read straight off
`layout()` because we hold the `Score` before we render it. That trick is free but it is not real:
the synthetic→real gap is the single most recurring finding in the project (V12's control-set note,
V14f's deferred ship gate, KAN-1426's still-open widened baseline, KAN-1487's font/typeface gap,
KAN-1512's chord-font/size gap found on real third-party scores via the `omr_viz` dashboard).

A large, real, previously-unseen corpus — hundreds of pages per PDF, several PDFs, genuine published
jazz lead sheets — is now available. It is the project's first chance to train and evaluate on the
distribution the product actually has to work on, not an approximation of it. Three things make that
hard rather than free, unlike the synthetic case:

1. **There is no `Score` to read ground truth off.** The generator's whole trick — render what you
   already hold — does not apply to a scan of someone else's printed chart. A human has to say what is
   actually on the page.
2. **The volume is real.** Hundreds of pages per PDF makes from-scratch annotation (draw every staff
   box, transcribe every note, type every chord) impractical as the primary method. It has to be
   **pre-label, then correct** — the recogniser's own (imperfect) output as a starting point — or the
   corpus never gets built.
3. **This is someone else's copyrighted sheet music, and it is not rights-cleared** (confirmed with the
   maintainer while writing this ADR) — not the maintainer's own rendered fixtures or phone photos.
   [ADR-0020](0020-omr-evaluation-strategy.md) already has a decision of record for exactly this shape of
   risk: "no corpus of copyrighted charts is retained or shared." That rule was written for the eval
   control set, before this initiative existed, but it applies at its word here too — this ADR is
   designed to build a real training dataset **without breaking it**, not to carve out an exception. See
   the amendment on ADR-0020 and part 4 below.

This ADR covers goals 1 and 2 of KAN-1522: a labelling studio, and the dataset it produces. Goal 3
(song identification) is [ADR-0037](0037-song-identification-via-chord-retrieval.md) — a different
kind of decision, made separately so this one stays about labelling and storage.

## Decision

**Pre-label with the existing bespoke/oemer engines, correct in an extension of the existing
`worker/devtools` viewer, and export to the exact corpus shape `worker/training/` already reads —
never a second data format.** Four parts.

### 1. Ingestion: rasterize always, use an embedded text layer opportunistically

Every PDF page is rasterized to a PNG at a resolution matching what the recognisers already expect
(oemer's own ~3.67 MP normalisation target, ADR-0023), because that is the only input the
segmentation/detection/CRNN stages understand — a lead-sheet PDF's vector paths, when present, are
glyph outlines, not a MusicXML-shaped semantic layer, so there is no fast path around recognition even
for a "digital" PDF. Separately and cheaply, each page is probed for an extractable text layer; where
one exists, the raw text (candidate titles, composer lines, chord-adjacent tokens) is kept as a bonus
pre-label seed for the studio's metadata step, never as a substitute for visual annotation.

This does **not** reopen [ADR-0018](0018-import-printed-raster-only.md). That ADR governs the
*product's* import boundary — one pipeline, raster-only, no vector fast path for a user's upload. This
ingestion is dev-time tooling building a *training dataset*, with a human in the loop and no
correctness guarantee owed to a live import job. The two can make different calls without contradicting
each other.

### 2. The studio is a new `worker/devtools/label_studio/`, not a new `packages/*` app or `packages/ui`

A sibling to `worker/devtools/omr_viz/` (EPIC-228), not an extension of it and not a browser feature.
Reasoning:

- The overlay machinery this needs — render a page, show Stage 1/2a/2b predictions on it, let a person
  inspect them per-stage — is exactly what `omr_viz` already built (KAN-1506/1507), including the
  internal functions `stage2a.py`/`chords.py` were refactored to expose (`_crop_box`/`_model_input`/
  `_run_columns`/`_band_bounds`) specifically so a caller other than the real pipeline can see each
  sub-stage. Reusing that machinery, in Python, in-process with `sibei_omr.engines.bespoke`, is far
  cheaper than re-deriving it in TypeScript behind a bridge process the way `omr-viz-bridge.ts` does for
  the *TypeScript*-side stages (KAN-1508) — those stages have no analogue here, since this tool never
  needs `mapOmrToScore` or the grammar corrector, only the raw per-stage objects.
- `packages/ui` is bound by invariants this tool has no business tripping: the byte-identical
  render-path guarantee (ADR-0014/0015), the framework-free core, the CLI/UI parity rule (Q79). An
  annotation tool that edits pixel boxes and CTC token sequences is not a product surface and must never
  be mistaken for one.
- A new `packages/*` package would need a Node-side bridge to the Python engines it is annotating
  (`sibei_omr.engines.bespoke`) — exactly the awkward direction `omr_viz`'s README already flags as "its
  own decision, deferred" for the *opposite* bridge (Python calling into TypeScript). Building it here,
  for no offsetting benefit, would be new complexity solving nothing.
- It is **not** the same app as `omr_viz` because the two have different failure costs. `omr_viz` is
  read-only and stateless — restart it and nothing is lost. A labelling tool holds hours of human
  correction that must not evaporate; giving it a separate app keeps that persistence requirement out of
  a tool whose whole design point (so far) is "no state to manage."

Its own `pyproject.toml`/venv, its own dependency group, same posture as `omr_viz` (never in CI, never
in the shipped worker image, ADR-0005/0024). It reuses `indah` and imports `sibei_omr.engines.bespoke`
directly, exactly as `omr_viz` does.

**The labelling loop.** For each page: rasterize it **transiently** — a scratch temp file for the
session, never written to the durable store (part 4 below) — run the current engine (bespoke or oemer,
engine-selectable) to produce Stage-1 boxes + Stage-2a tokens + Stage-2b chords exactly as the server
would for a real import, and overlay them, editable — drag/resize/delete/add a Stage-1 box, edit a
decoded note's pitch/duration/order, edit a chord's text/span. A "commit page" action validates the
correction against the same TypeScript label shapes training already trusts (below) and persists
**only that structural data, never the raster**. A per-song manifest tracks each page's status
(unlabelled / pre-labelled / corrected) keyed by `(source PDF path, page number)`, so a
hundreds-of-pages PDF survives being labelled across many sessions and reopening a page for re-review
simply re-rasterizes it from the same source file.

### 3. Ground truth is shaped like `packages/synth`'s labels — because that shape is already the training contract

> **Amended 2026-10-23.** "Exactly" below is superseded: the three shapes are kept as a **subset** of a
> wider label (see the Amendment). The training loaders still parse them unchanged.

The corrected label for a page is not a new schema. It is the same three shapes the synthetic pipeline
already produces and the training scripts already consume:

| Stage | Shape (already exists) | Consumed by |
|---|---|---|
| 1 — layout | `PageObjectBox[]` (`packages/synth/src/page-boxes.ts`) — `{cls, clsId, box, system}` | `training.detect_train` via `worker/training/detect_dataset.py` |
| 2a — melody | `SystemLabel` (`packages/synth/src/systems.ts`) — `{index, box, tokens, tokenIds}` | `training.train` via `worker/training/dataset.py` |
| 2b — chords | `SystemChords` (`packages/synth/src/chord-labels.ts`) — `{index, page, hasBand, chords}` | `training.chord_train` via `worker/training/chord_dataset.py` |

The studio's commit step validates a correction against these exact TypeScript types (a small bridge
script, the same shape as `scripts/omr-viz-bridge.ts`, since the types and the vocabularies —
`vocab.ts`, `chord-vocab.ts` — are TypeScript-owned and must not be reimplemented in Python where they
could drift). This is what makes "plugs into the existing eval harness and training scripts without
inventing a second format" true by construction rather than by discipline.

### 4. Storage: derived structural data only, never the raster — re-derived transiently for training

**Confirmed with the maintainer: this corpus is not rights-cleared, so ADR-0020's "no corpus of
copyrighted charts is retained" applies at its word — not just to git, to any durable copy at all.**
That is a harder constraint than "keep it out of version control" (ADR-0033's posture for the
*synthetic* corpora), and it collides with how a training corpus normally works: `worker/training/
{dataset,detect_dataset,chord_dataset}.py` all pair a `labels.jsonl` record with an **image file** —
the model trains on pixels, and a coordinate with no pixel behind it teaches a CRNN or a CenterNet
nothing about how real ink, fonts or scan noise actually look, which is the entire reason this corpus
is worth having. The two needs are reconciled by **never treating the raster as something the app
owns**: the maintainer already owns the source PDFs, outside this project entirely, and the app's job
is to produce *structural* labels durably while re-deriving pixels *transiently*, on demand, only for
as long as a labelling session or a training run needs them.

The durable store is song/page-keyed, and holds **no image data**:

```
$SIBEI_REAL_CORPUS_DIR/             # default ~/.local/share/sbscore/real-corpus, NEVER committed
  manifest.json                    # {songs: [{id, title, composer, sourcePdfPath, pageCount, status}]}
  labels/<song-id>/<page>.json     # PageObjectBox[] + provenance (engine, pre-label vs corrected) — no pixels
  systems/<song-id>/<page>-<sys>.json   # SystemLabel (box coordinates + token sequence) — no pixels
  chords/<song-id>/<page>-<sys>.json    # SystemChords (chord text + box coordinates) — no pixels
  fingerprints/<song-id>.json      # the ADR-0037 chord-progression fingerprint — no pixels
```

Every record carries `sourcePdfPath` + a page number, not a copy of the page. A new exporter
(`pnpm export:real-corpus --stage detect|stage2a|chords --out out/real-<stage>-corpus`) reads the
labels, **re-rasterizes each referenced page from the maintainer's own retained PDF at export time**,
and writes the identical on-disk shape the existing `*_dataset.py` loaders already parse (manifest +
`labels.jsonl` + an image directory) into `out/`, gitignored — exactly like a synthetic corpus dump,
but ephemeral for a second, sharper reason: not merely "free to regenerate" (ADR-0033's framing) but
"must not persist beyond the run that needs it." The acceptance test for this ADR is unchanged by this
tightening: point `training.detect_train`/`training.train`/`training.chord_train` at an exported
directory and have it load with **zero changes** to those three files. The one small, additive change
training needs is accepting **more than one** `--corpus` directory, so a synthetic and a real corpus
mix in one run.

**If a source PDF ever becomes unavailable (moved, deleted), its derived labels remain usable data
about shapes and structure, but its export step fails loudly rather than silently skipping the
song** — a page with no reachable source is not trainable pixels, and the manifest's `status` field
records that rather than quietly shrinking the exported corpus.

**A per-song `rightsCleared` flag is deliberately not built.** The maintainer confirmed this whole
corpus is uncleared; if a future, genuinely licensed corpus arrives, it is different enough (no raster
constraint at all) that it earns its own ADR rather than a flag bolted onto this one.

**This also means `tests/fixtures/eval/real/`'s growth (goal 2's other half) is a separate, lighter
workflow, not this store.** That directory is the small, curated eval **control set**
(`docs/eval.md`), and its own README already asks for photos the maintainer has the right to commit.
Growing it uses the *existing* import-and-correct loop (`sbscore import`, the V14 browser review, `sbscore
open --json`) at a larger scale — not the studio, and not `SIBEI_REAL_CORPUS_DIR` — and stays bound by
that README's "keep it small, and a genuine photo" discipline. Preferring the maintainer's own phone
photos of physically-owned charts for anything actually committed avoids exactly the ambiguity a
third-party PDF corpus would otherwise introduce into a git-tracked test fixture. See SLICES.md V28.

## Amendment (2026-10-23): expressive labels — record wide, train narrow

**Why.** The first real pages (a full-band intro with a grand staff, drum staff, diamond heads and an
8va line; a lead sheet with triplets) showed that "exactly the three synthetic shapes" is too narrow
a record. Leaving a staff unlabelled makes the detector learn it is *background*, and labelling only
what today's vocabulary expresses means redoing every page each time it widens. The maintainer's
direction is full notation in the long run ([ADR-0038](0038-full-notation-is-the-long-term-direction.md));
labels are the one asset that cannot be regenerated, so they are recorded at the fidelity a human can
supply cheaply and **projected down** by the exporter. Decided with the maintainer, 2026-10-23.

**The label is a superset.** Every record still carries the three existing shapes' fields; the
additions are optional, ignored by the existing loaders, and live beside them (extra JSON keys, never a
second format):

| Addition | Where | Meaning |
|---|---|---|
| `kind` | every region (`PageObjectBox`) | An **open string**. Seed taxonomy: `lead-staff`, `accompaniment-staff`, `drum-staff`, `chord-band`, `title`, `rehearsal-mark`, `tempo`, `footer`, `other` — plus `barline`, unchanged. `lead-staff`/`chord-band`/`title`/`barline` map to the detector's current `BOX_CLASSES` (`staff` ≙ `lead-staff`); every other kind has **no `clsId` yet**. |
| `attrs` | a staff region | Optional and free: `clef`, a `group` id shared by the staves of one brace/bracket (a grand staff), a `role` note. Recorded, not trained on. |
| `status` | every region and every system | `transcribed` (content complete, all in-vocab) · `partial` (some content not captured; its positions are recorded as extended tags) · `structure-only` (region and kind, no content) · `ignore` (do not train or score). **Never absent**: a region the human has not touched is `pre-labelled`, which the exporter treats as `ignore`, so an unreviewed engine guess is never trained on as truth. |
| `extended` | a system | Positioned **extended tags** for what the vocabulary cannot yet say: `{tag, box, note?}` with `tag` in an open `x:` namespace (`x:tuplet(3,2)`, `x:notehead=diamond`, `x:8va`, `x:accent`). A record of what was seen, not a notation language (ADR-0038 risk). |

**What the exporter does with it** (replacing "reads the labels and writes the identical shape"):

- **Stage 1 (detect).** Regions whose `kind` has a `clsId` are written as boxes. Regions with **no
  `clsId`** (and anything `ignore`/`pre-labelled`) are **masked**: because the exporter already
  re-rasterizes transiently, it fills the box white in the training image, so the detector sees a blank
  rather than an unlabelled staff, and **no training-script change is needed** — the acceptance test
  below survives. Adding a detector class later (e.g. `drum-staff`) is then a re-export, not a re-label.
- **Stage 2a (melody).** Only systems with status `transcribed` and every token in the vocabulary are
  exported; a CTC loss cannot take an unknown token without corrupting the alignment. A `partial` system
  still feeds Stage 1 and 2b.
- **Stage 2b (chords).** Bands with status `transcribed` and chord text are exported.
- **Evaluation.** The harness excludes `ignore` / `structure-only` / `pre-labelled` regions from the
  metrics rather than scoring them as misses.

The commit-time validation (part 3's bridge script) checks the **subset** against the TypeScript
types and the new fields against a small schema owned beside them in `packages/synth`; an unknown
`kind` or `status` is refused, an unknown `x:` tag is accepted (it is an open record).

**Cost, stated.** More fields per page means slower labelling. The tiers are deliberately uneven:
choosing a `kind` is a click; transcribing notes is expensive; an `x:` tag is optional and a free-text
note will do at first. Throughput, not a page count, stays the metric (Consequences, below).

## Consequences

- **Two real, separately-justified data stores exist after this:** the large, private, song/page-keyed
  `SIBEI_REAL_CORPUS_DIR` (structural labels only, never a pixel, never committed) and the small,
  curated, git-committed `tests/fixtures/eval/real/` (the eval control set, already existed, just
  grows, and stays bound to photos the maintainer has the right to commit). Confusing the two would
  either bloat git with copyrighted scans or starve training of real volume — the split is deliberate,
  not incidental.
- **No copyrighted pixel ever persists longer than one labelling session or one export/train run.**
  This is a stronger property than ADR-0033's "gitignored" for the synthetic corpora — it holds even
  against the maintainer's own disk, not just against git — and it is what makes this ADR compatible
  with ADR-0020 rather than a quiet exception to it.
- **No training-script rewrite.** `worker/training/*.py` gains only a multi-corpus `--corpus` list; the
  dataset *shape* is unchanged, so this ADR adds no new failure surface to code that already trained
  three production models.
- **The studio inherits `omr_viz`'s isolation discipline** (own venv, never CI, never the shipped image)
  rather than inventing a new one — a known-good pattern from EPIC-228, not a new risk.
- **Labelling throughput, not a page-count target, is the metric.** The actual PDF count and total page
  count are not yet known to this planning pass (the corpus was not available to inspect while writing
  it) — V27's first slice is pointing the studio at the real files and finding out, the same
  gate-before-build discipline V9/V15 already used for an unknown this project could not check from a
  desk. See `QUESTIONS.md` Q85/Q86.

## Alternatives considered

| Option | Why not |
|---|---|
| Retain rasterized pages/crops durably in `SIBEI_REAL_CORPUS_DIR` (the original draft of this ADR) | Directly breaks ADR-0020's "no corpus of copyrighted charts is retained," confirmed still binding for this specific corpus. Rejected once the rights question was actually asked, not assumed; see the ADR-0020 amendment. |
| Build a new `packages/label-studio` TypeScript app | Would need a Node↔Python bridge to run the exact engines being annotated, solving nothing `omr_viz`'s existing in-process Python access doesn't already solve for free. |
| Extend `packages/ui` (the product browser) with an annotation mode | Binds an internal tool to product invariants (ADR-0014/0015, CLI/UI parity) it has no reason to satisfy, and risks a real regression in the actual product surface for dev-tooling's sake. |
| Extend `omr_viz` itself in place | Conflates a stateless qualitative viewer (EPIC-228's stated scope) with a stateful labelling tool holding hours of irreplaceable human correction — different failure costs deserve different blast radii. |
| Label only what the vocabulary expresses, or only whole pages (the first draft's "exactly the synthetic shapes") | Leaves real staves as detector *background* and forces a re-label on every vocabulary widening. Superseded by the 2026-10-23 amendment. |
| Invent a new label schema tailored to real photos | Directly contradicts the goal ("plugs into the existing eval harness and training scripts without inventing a second format") for no accuracy benefit — the existing shapes already carry everything a page can need. |
| Store the real corpus in the product's SQLite `Store` | It is training reference data, not a user's library (ADR-0002's "server owns the score" is about a person's chart, not a labelling corpus); mixing them would leak dev-only data into the product's backup/export/migration surface. |
