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
| VexFlow | Draw adapter | MIT | Yes | Own engraver (ADR-0014) |
| Bravura | SMuFL music font. Via VexFlow, and since V1b also read directly — see the note below | SIL OFL | Yes | — |
| SQLite | Store | Public domain | Yes | Postgres at hosting (ADR-0006) |
| Svelte 5 + Vite | UI shell | MIT | Yes | Framework-free core makes it swappable (ADR-0022) |

### Register note, 2026-07-31: Bravura is now vendored as well as bundled

V1b's engraver reads Bravura's own published metrics rather than VexFlow's copy of them
(ADR-0030). No new dependency: same font, same SIL OFL 1.1 licence, same offline story.
What changed is the delivery route, and it changed in the direction this ADR prefers —
`scripts/vendor-bravura.ts` generates a 12 KB checked-in slice of fifteen glyph outlines
plus the `engravingDefaults` table from the pinned `bravura-1.392` release, so
`pnpm install` reaches the network for it never rather than once. Attribution is in
`packages/engrave/NOTICE.md`.

SMuFL's `glyphnames.json` is read at vendoring time to resolve glyph names to codepoints
and is **not** redistributed, so it is not a dependency and does not enter this register.

## Alternatives considered

| Option | Why not |
|--------|---------|
| EasyOCR | Easier to install, but a less accessible fine-tuning path — and fine-tuning is the whole of stage 2. |
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
