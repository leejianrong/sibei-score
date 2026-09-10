# Screenshots

Real captures of the browser (`packages/ui`), regenerated with `pnpm screenshots`
(`scripts/screenshots.ts`) — it boots `sbscore serve` + `vite` + a real Chromium, authors a few
charts through the CLI, and drives the UI to each state. They are illustrative, not a snapshot
test, so regenerate them after a UI change that alters a captured state.

| File | What it shows |
|---|---|
| `library.png` | The library view: a searchable list of charts by title, composer, key and version |
| `library-search.png` | The same view, filtering as you type |
| `score-view.png` | A chart open in the engraved (Bravura) face, with the rail: review state, face, paper, export |
| `score-view-jazz.png` | The same chart in the handwritten (Petaluma) Real Book face — a per-render choice |
| `inspector.png` | A note selected on the sheet, with the inspector for pitch, duration and accidental (V4c) |
| `take-five.png` | A chart in 5/4, so the gallery isn't all one time signature |
