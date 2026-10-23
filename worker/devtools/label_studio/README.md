# Labelling studio (dev tooling, ADR-0036)

Pre-label real PDF pages with the bespoke OMR engine, correct them by hand, and keep the
**derived structural labels** — the training data the synthetic corpus can't supply. Dev-only:
never imported by product code, never in CI, never in the shipped worker image (same posture as
`../omr_viz`, built with [indah](https://github.com/leejianrong/indah)).

**No page image is ever kept.** The real PDF corpus is not rights-cleared (ADR-0020's amendment), so a
page is rasterized into a per-process scratch directory (`mkdtemp`, mode 0700) and deleted at exit.
Nothing is written next to the PDF or into the repo. Labels hold coordinates, kinds, statuses, tokens and
text keyed by `(source PDF path, page)` — never pixels (`labels.scan_for_pixels` is the test of that).

## Status

SIB2-126: a **workbench** — one full-viewport screen: a one-row app bar (file, pager, page state,
Commit), the page on a tonal canvas, and a side sheet with the selected region's kind and status plus a
review list grouped by system. Material 3 roles come from `m3_theme.py` (seeded with the product's
accent, `#22409c`, as in `packages/ui/src/m3.css`) and follow the OS light/dark setting.

**The review loop** (click the page first): `Tab` / `Shift Tab` jump to the next / previous unreviewed
region, `Enter` confirms it and moves on, `1`–`6` set its kind, `Delete` removes it, arrows nudge (Shift:
10px), `Ctrl Z` undoes, `W` / `F` fit width / page, `Ctrl S` commits, `?` lists them. Drag a box to move
it, a handle to resize, empty space to draw (as the kind in "Draw as"). Ctrl-wheel zooms. The ⋮ menu has
**Confirm all unreviewed** and **Reset to engine pre-label**; leaving a page with uncommitted edits asks.

Every region has a **kind** (`lead-staff`, `accompaniment-staff`, `drum-staff`, `chord-band`, `title`,
`rehearsal-mark`, `tempo`, `footer`, `other`, `barline`) and a **status**: dashed = `pre-labelled`
(an unreviewed engine guess, kept **out of training**), solid = reviewed (`structure-only` shown as
*Confirmed*, `partial`, `transcribed`), hatched = `ignore`. See ADR-0036's 2026-10-23 amendment and
`labels.py`. **Commit** writes `labels/<song-id>/<page>.json` and flips the page to `corrected` in
`manifest.json` under `$SIBEI_REAL_CORPUS_DIR` (default `~/.local/share/sbscore/real-corpus`); reopening
a committed page restores it. Notes and chords (Stage 2a/2b) are SIB2-118/119; validation against the
TypeScript label types is SIB2-120; the exporter that projects labels onto training is SIB2-108.

The screen is an indah ES-module custom component (`modules/workbench.js`), because indah's
`ImageOverlay` is display-only and the review loop needs a keyboard-first canvas. It covers indah's own
shell bar (`position: fixed`), so there is no indah chrome, theme toggle included.

## Running it

```sh
make label-studio                       # setup is skipped once the venv + weights exist
make label-studio INDAH_PATH=/path/to/indah-python-ui
LABEL_STUDIO_PDF_DIR=~/scores make label-studio   # default: ./examples (gitignored locally)
```

Needs poppler on `PATH` (`pdftoppm`, `pdfinfo`, `pdftotext`; `apt install poppler-utils`).
Pages render near 3.67 MP — oemer's own normalisation target (ADR-0023) — whatever the page size.

## Tests

```sh
cd worker/devtools/label_studio && .venv/bin/python -m unittest discover -s tests
```
