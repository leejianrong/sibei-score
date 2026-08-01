# ADR-0027: PaddleOCR for the chord band; the dependency register

- Status: Accepted
- Date: 2026-07-30
- Deciders: Jian (via `/plan-new-project`, resume mode)

## Context

ADR-0011 staged chord recognition so the MVP uses an off-the-shelf recogniser plus a
grammar corrector, with fine-tuning on synthetic data as stage 2. It named "PaddleOCR
or EasyOCR" without choosing. Separately, oemer's own README recommends `homr` as "an
awesome improved version of this project", which needed checking before building on
oemer.

The coverage checklist also requires every dependency to be named with its licence, its
offline story, and a fallback — not left as a shortlist.

## Decision

**PaddleOCR** for the chord-band recogniser. Both candidates are Apache-2.0 and both
run fully offline, so the tiebreaker is stage 2: PaddleOCR has the more accessible,
better-documented fine-tuning pipeline, and fine-tuning on synthetic chord symbols is
exactly what stage 2 is. EasyOCR's advantage is easier installation, which matters less
inside a container that is built once.

**`homr` is rejected**, and examining it strengthened the oemer choice rather than
threatening it.

The dependency register of record:

| Dependency | Role | Licence | Offline | Fallback |
|---|---|---|---|---|
| oemer (pinned, Oct 2023) | Base OMR: notes, barlines, coordinates | MIT | Yes, weights baked in (ADR-0024) | Vendored fork (ADR-0023) |
| onnxruntime | oemer's default inference engine | MIT | Yes | TensorFlow, which oemer also supports |
| PaddleOCR | Chord-band text recognition | Apache-2.0 | Yes, weights baked in | EasyOCR, same interface shape |
| OpenCV | Preprocessing: deskew, crop, contrast | Apache-2.0 | Yes | — |
| Bravura | SMuFL music font, the `normal` face. Vendored metrics and outlines — see the note below | SIL OFL 1.1 | Yes | — |
| Petaluma | SMuFL music font, the handwritten `jazz` face | SIL OFL 1.1 | Yes | Bravura |
| SQLite | Store | Public domain | Yes | Postgres at hosting (ADR-0006) |
| Svelte 5 + Vite | UI shell | MIT | Yes | Framework-free core makes it swappable (ADR-0022) |

### Register note, 2026-07-31: VexFlow out, two fonts vendored in

**VexFlow has left the register.** ADR-0030 replaced it with our own engraver, and
`packages/draw` and the `vexflow` dependency were removed at V1d. The register is one
runtime dependency shorter, and the row it occupied listed "Own engraver" as its own
fallback, which is now simply what is there.

**jsdom has left the server render path** for the same reason. The engraver emits markup
rather than DOM nodes, so `packages/pdf` no longer installs a headless DOM.

**Both fonts are vendored, not bundled.** `scripts/vendor-music-fonts.ts` generates a
checked-in slice of each — 43 glyph outlines plus the `engravingDefaults` table, from a
pinned release — so `pnpm install` reaches the network for them never rather than once.
That is the direction this ADR prefers. Attribution is in `packages/engrave/NOTICE.md`.

Two things that run at vendoring time and never ship, so neither enters this register:
`opentype.js` (MIT), which reads Petaluma's outlines because Petaluma publishes no SVG
font; and SMuFL's `glyphnames.json`, which resolves glyph names to codepoints and is not
redistributed.

### Register note, 2026-07-31: the SQLite binding, and the one build script

V2a gave the SQLite row a concrete driver: **`better-sqlite3` (MIT)**, offline, with Node's
built-in `node:sqlite` as the fallback. It is the store's only dependency and the only thing
`packages/api` declares.

This is worth recording because it sits in **tension with the note above** — the one that
prefers vendoring so `pnpm install` reaches the network never rather than once.
`better-sqlite3` compiles or downloads a native binding at install time, which makes it the
single install-time code execution in the tree, allowlisted explicitly in
`pnpm-workspace.yaml` alongside esbuild's.

The alternative was taken seriously and rejected on the merits rather than on habit.
`node:sqlite` is zero dependencies and zero build scripts, and would have honoured the
preference exactly. But on Node 24 it still emits `ExperimentalWarning: SQLite is an
experimental feature and might change at any time`, and it collapses every constraint failure
into one generic error code, so telling a unique violation from a check violation means
matching on a message string. Neither is acceptable underneath a store holding the data
ADR-0028 calls irreplaceable, and an experimental API is a poor foundation for the one thing in
the app that must not lose anything.

The reversal is cheap and deliberately so: ADR-0006's port means both files that know SQLite
exists are in `packages/api/src/store/`, `tests/arch/store-seam.test.ts` keeps it that way, and
swapping the driver is a change to one of them. Revisit when `node:sqlite` loses the warning.

### Register note, 2026-08-01: the UI row gets concrete

V4b turned the register's "Svelte 5 + Vite" row into installed versions: **svelte 5.56.8**, **vite
7.3.6**, **@sveltejs/vite-plugin-svelte 6.2.4** and **svelte-check 4.7.4**, all MIT and all
offline after install. Only `svelte` ships in the bundle; the other three are build and check
tooling and never reach a page.

Two things worth recording rather than leaving to be rediscovered.

`svelte-check` is in the register because it is the UI's **entry in the root `typecheck` script**.
`tsc -p` cannot read a `.svelte` file, so a UI checked with `tsc` would have had its components
silently unchecked — which is the same failure the script's habit of naming every package
explicitly exists to prevent. It runs inside the existing `typecheck` CI job; no seventh job.

The row's stated fallback — "the framework-free core makes it swappable" — is now a fact rather
than a claim. `packages/ui` imports `@sibei/layout` and `@sibei/engrave` directly and composes
them in six lines, so what a framework swap would rewrite is `App.svelte` and four components,
not the render path. `tests/arch/framework-free.test.ts` asserts it, and as of this slice it does
so with Svelte genuinely in the tree instead of vacuously.

## Alternatives considered

| Option | Why not |
|--------|---------|
| EasyOCR | Easier to install, but a less accessible fine-tuning path — and fine-tuning is the whole of stage 2. |
| `node:sqlite` instead of better-sqlite3 | Zero dependencies and no build script, which this ADR would otherwise prefer — but still flagged experimental on Node 24 and it has no per-constraint error codes. See the register note above. |
| `homr` as base engine | **AGPL-3.0**, which avoiding was an explicit reason for rejecting Audiveris given the hosted future. Outputs **MusicXML only with no exposed coordinates**, so stage 3 could not work. And it covers only pitch and rhythm, "neglecting dynamics, articulation … and other musical symbols", so it contributes nothing to chord recognition. |
| Tesseract | Weakest of the three on short, stylised, non-linguistic text, which is exactly what a chord symbol is. |

## Consequences

- Every runtime dependency is permissively licensed — MIT, Apache-2.0, SIL OFL or
  public domain. Nothing blocks the hosted future, which was a stated reason for
  several earlier choices.
- No dependency requires network access at runtime once ADR-0024's build-time weight
  baking is in place.
- oemer being unmaintained since October 2023 is the register's weakest entry. The MIT
  licence and the worker's isolation (ADR-0005) are the mitigations.
- Choosing PaddleOCR now commits stage 2's fine-tuning work to PaddlePaddle's tooling.
  Switching recognisers later would mean redoing that work, so this decision is more
  expensive to reverse than it looks.
