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

Slice SIB2-117: open a PDF page, see Stage 1's pre-label, and **correct it** — drag a box to move it,
drag a handle to resize, drag empty space to draw, Delete to remove, Ctrl-Z / Ctrl-Shift-Z to undo and
redo, arrows to nudge (Shift: 10px), Ctrl-wheel or the +/− buttons to zoom. Every region has a **kind**
(`lead-staff`, `accompaniment-staff`, `drum-staff`, `chord-band`, `title`, `rehearsal-mark`, `tempo`,
`footer`, `other`, `barline`) and a **status** (`pre-labelled` = an unreviewed engine guess, `structure-only`,
`partial`, `transcribed`, `ignore`) — see ADR-0036's 2026-10-23 amendment and `labels.py`. **Commit page**
writes `labels/<song-id>/<page>.json` and flips the page to `corrected` in `manifest.json`, under
`$SIBEI_REAL_CORPUS_DIR` (default `~/.local/share/sbscore/real-corpus`). Reopening a committed page
restores it. Notes and chords (Stage 2a/2b) are SIB2-118/119; validation against the TypeScript label
types is SIB2-120; the exporter that projects these labels onto training is SIB2-108.

The editor is an indah ES-module custom component (`modules/region-editor.js`), because indah's
`ImageOverlay` is display-only. Unreviewed (`pre-labelled`) and `ignore` regions are **masked** by the
exporter, never trained on as truth, so use **Confirm all unreviewed** only once you have looked.

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
