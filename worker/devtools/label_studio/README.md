# Labelling studio (dev tooling, ADR-0036)

Pre-label real PDF pages with the bespoke OMR engine, correct them by hand, and keep the
**derived structural labels** — the training data the synthetic corpus can't supply. Dev-only:
never imported by product code, never in CI, never in the shipped worker image (same posture as
`../omr_viz`, built with [indah](https://github.com/leejianrong/indah)).

**No page image is ever kept.** The real PDF corpus is not rights-cleared (ADR-0020's amendment), so a
page is rasterized into a per-process scratch directory (`mkdtemp`, mode 0700) and deleted at exit.
Nothing is written next to the PDF or into the repo. Labels, when they land (SIB2-117+), hold
coordinates, tokens and text keyed by `(source PDF path, page)` — never pixels.

## Status

Slice SIB2-116: open a PDF page, see Stage 1's pre-label (staff / barline / chordBand) overlaid.
Read-only. Correcting and committing are the next slices — see epic SIB2-E7 and `SLICES.md` V27.

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
