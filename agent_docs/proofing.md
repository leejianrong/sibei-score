# Proofing visual output — do this, it is not optional

Engraving defects are visual and the test suite does not catch them. 82 green tests and a
passing snapshot coexisted happily with every beamed note drawing a stray flag *and* a
doubled stem. Someone had to look. **After any change that touches `layout`, `engrave` or
`pdf`, look at the result.**

```sh
pnpm proof                            # every fixture, whole pages
pnpm proof nasty-chart --systems      # every system as its own image
pnpm proof nasty-chart --bar 6        # one bar, zoom chosen for you
pnpm proof nasty-chart --system 2 --census
pnpm proof nasty-chart --pdf          # proof the PDF itself, if a rasteriser is present
pnpm proof nasty-chart --bar 6 --compare    # committed snapshot above, this render below
pnpm proof nasty-chart --bar 6 --font jazz  # the handwritten face
```

`--compare` earns its keep the same way `--census` does. It was built for the V1b gate to
stack VexFlow against the engraver; VexFlow is gone and it kept its job by changing what
it compares — the **committed snapshot** above, **your working tree** below, same crop and
same zoom. Reach for it when a snapshot moves: `--census` tells you *what* changed, this
tells you what it looks like. Between them they have caught a stem pointing the wrong way
on a note sitting on the middle line, a repeat sign doubled under a system's opening
barline, and an ending bracket sitting on top of a chord symbol — none of which any test
had an opinion about.

Crops are named after the music, not pixel coordinates: layout knows where every system
and bar sits, so `--bar 11` is exact and the zoom lands at a readable size on its own.
Each run prints a manifest of what it wrote and what each image shows, so **read those
files** — that is the point of the tool.

**Where the output goes.** `out/` is gitignored in full and is entirely regenerable — a
directory per fixture, so one chart's artefacts sit together:

```
out/render/nasty-chart/nasty-chart.pdf   page1.svg          # pnpm render
out/proof/nasty-chart/page1.png  bar6.compare.png  bar6.jazz.png    # pnpm proof
out/proof/manifest.json                  # one per run, spanning every fixture in it
```

The PDF keeps the fixture's name because it is the thing you open or attach; everything else
drops it, because the directory already said it.

**A fixture's directory is emptied at the start of its run**, so what is in it is exactly what
the last run produced — which is the only thing that makes the manifest trustworthy. Without
that, a file whose name no longer matches anything the tool emits sits there looking current
forever: `nasty-chart.page1.engraver-normal.svg` outlived the two-adapter era by three slices,
because the naming died with `packages/draw` and the file did not.

**Crops are page-aware, and were not always.** A crop carries the page its music is on, so
`--bar 41` on a two-page chart renders page 2 and cuts from page 2. Until V3b it carried a
rectangle and no page, so it cut page 2's rectangle out of page 1's markup — no error, just
a convincing image of the wrong thing. That was invisible for as long as every fixture fit
one page, which is the shape of tooling bug worth expecting: it does not fail, it lies.
`--census` likewise diffs each page against its own snapshot.

`--census` is the highest-value flag. It counts the SVG's elements and diffs them against
the committed snapshot:

```
vf-stem     73  58  -15        <- 15 beamed notes were drawing two stems each
<path>     344 314  -30        <- ...and a flag each on top of that
```

That table is what diagnosed the beaming bug, where the raw snapshot diff said only
"one very long line differs". Reach for it whenever a snapshot moves and you want to know
*what* moved before you accept it.

**Never refresh a snapshot to make a red test green.** Run `--census`, understand the
delta, look at the image, and only then accept it.

Proofing the PDF needs an external rasteriser. None is committed because ADR-0027 keeps
the dependency register permissive and the capable ones are mostly copyleft — a tool you
look at output with is a separate program, not part of the product, but it does not belong
in the lockfile either. Any one of these works, and `pnpm proof --pdf` finds it:

```sh
uv tool install --with pillow pypdfium2   # no root; PDFium, BSD/Apache
sudo apt install poppler-utils            # pdftoppm; GPL
sudo apt install mupdf-tools              # mutool; AGPL
```

With none installed, `--pdf` says so and carries on. Little is lost: the PDF is a
conversion of exactly the SVG geometry and an e2e test pins it to identical bytes, so the
SVG proof stands in for the engraving and only the conversion goes unseen.

The older single-file previewer is still there for ad-hoc use:

```sh
pnpm tsx scripts/preview.ts out/render/nasty-chart/page1.svg 2
pnpm tsx scripts/preview.ts out/render/nasty-chart/page1.svg 4 --crop 60,150,900,200
```

Refresh SVG snapshots **deliberately**, never to make a red test go green without reading
the diff first:

```sh
UPDATE_SNAPSHOTS=1 pnpm test
```
