# Screenshots

Real captures of the browser (`packages/ui`), regenerated with `pnpm screenshots`
(`scripts/screenshots.ts`) — it boots `sbscore serve` + `vite` + a real Chromium, authors a few
charts through the CLI, and drives the UI to each state. They are illustrative, not a snapshot
test, so regenerate them after a UI change that alters a captured state. (`pnpm screenshots` clears
only the browser PNGs it regenerates; this README and the OMR shot below are preserved.)

| File | What it shows |
|---|---|
| `library.png` | The library view: a searchable list of charts by title, composer, key and version |
| `library-search.png` | The same view, filtering as you type |
| `score-view.png` | A chart open in the engraved (Bravura) face, with the rail: review state, face, paper, export |
| `score-view-jazz.png` | The same chart in the handwritten (Petaluma) Real Book face — a per-render choice |
| `inspector.png` | A note selected on the sheet, with the inspector for pitch, duration and accidental (V4c) |
| `structure-panel.png` | A bar selected, with the Structure panel for its section, barlines and endings (V7c) |
| `take-five.png` | A chart in 5/4, so the gallery isn't all one time signature |

## OMR (the bespoke recogniser, v0.3)

Not a browser capture — the **bespoke Stage-2a engine** (V15c, ADR-0031) reading a chart, drawn by
`worker/visualize_bespoke.py`. Red dots are recognised noteheads (labelled with the pitch import reads
+ the predicted duration, e.g. `C48` = C4 eighth), green squares are rests, blue lines are barlines.

| File | What it shows |
|---|---|
| `bespoke-omr.png` | The bespoke engine's note/rest predictions overlaid on a clean **synthetic** chart (non-copyrighted, so it can be committed) — the markers land on the real noteheads with correct rhythm |

Regenerate (needs the baked model in `out/v15b` and the worker inference venv):

```sh
# render a synthetic page, then overlay the model's predictions
pnpm tsx -e "import{writeFileSync}from'node:fs';import{generateScore}from'@sibei/synth';import{renderScoreToPng}from'@sibei/synth/imaging';writeFileSync('out/demo.png',renderScoreToPng(generateScore({seed:7,bars:8}),{zoom:2,pageSpec:{}})[0])"
SIBEI_BESPOKE_MODEL_DIR=out/v15b python worker/visualize_bespoke.py out/demo.png --out out/demo-out
# then crop out/demo-out/demo.pred.png to the content area and save as bespoke-omr.png
```
