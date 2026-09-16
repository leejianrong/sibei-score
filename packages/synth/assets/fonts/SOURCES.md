# Vendored text fonts (V17a-iii, dev-only)

These TTFs give the OMR training corpus a variety of **text** typefaces for the title block and
chord symbols (domain randomisation, ADR-0031). They are committed rather than converted to path
data — unlike the SMuFL *music* fonts in `packages/engrave/src/fonts/`, which are emitted as SVG
`<path>` outlines — because chord text is arbitrary: we cannot pre-convert glyphs we do not know in
advance. They are **dev-only**: `packages/synth` is the sanctioned ADR-0031 exception and `tests/arch`
keeps it out of every product bundle, so no shipped artefact contains these files.

They are loaded into `@resvg/resvg-js` as `fontFiles` (resvg-js 2.6.2 takes paths, not buffers) by
`src/imaging/fonts.ts`, alongside the system fonts (`loadSystemFonts: true`), so the *primary*
typeface is deterministic (always vendored)
while a rare glyph a face lacks — notably the music flat `♭` (U+266D), which none of these text fonts
carry — still resolves through the system's fonts, exactly as the corpus did before this change.

Glyph coverage that drives the symbology coupling in `src/text-fonts.ts` (verified with fontkit):
all four carry `ø` (U+00F8), `°` (U+00B0) and ASCII `b`/`#`; only the serif/sans carry `Δ` (U+0394),
so the handwriting faces force a spelled major-seventh (`maj`/`M`) instead.

| File | Family | Style | License | Δ |
|---|---|---|---|---|
| `Tinos-Regular.ttf` | Tinos | serif (Times-metric) | Apache-2.0 (`LICENSE-Tinos.txt`) | yes |
| `Arimo-Regular.ttf` | Arimo | sans (Arial-metric) | Apache-2.0 (`LICENSE-Arimo.txt`) | yes |
| `PatrickHand-Regular.ttf` | Patrick Hand | handwriting | OFL-1.1 (`LICENSE-PatrickHand.txt`) | no |
| `Caveat.ttf` | Caveat | handwriting (casual) | OFL-1.1 (`LICENSE-Caveat.txt`) | no |

## Provenance (pinned)

Downloaded 2026-09-16 from the upstream font repos:

- Tinos — https://raw.githubusercontent.com/googlefonts/tinos/main/fonts/ttf/Tinos-Regular.ttf
- Arimo — https://raw.githubusercontent.com/googlefonts/Arimo/main/fonts/ttf/Arimo-Regular.ttf
- Patrick Hand — https://raw.githubusercontent.com/google/fonts/main/ofl/patrickhand/PatrickHand-Regular.ttf
- Caveat — https://raw.githubusercontent.com/google/fonts/main/ofl/caveat/Caveat%5Bwght%5D.ttf (default instance)

## Checksums (sha256)

```
41b22bc8f0b51f932825d37bc55b5eb6ba67dfe599a626e4aff2b43b624f9f8c  Arimo-Regular.ttf
0bdb6b660482d31531b3945849fba5916b3ef8695da7024a9e6b9ee3c4157988  Caveat.ttf
0f173b3e6cb6d1af25babf7f0057c5ac4ee11f9992b0469bb817e967ef4ad0fc  PatrickHand-Regular.ttf
60a0e8ef0c04dd5dd69ffe91025fa2ae5836cbd35600a82ba031977557e2cb61  Tinos-Regular.ttf
```

A future authentic Real-Book chord face (e.g. MuseJazz Text, OFL) could join this set; its glyph
coverage must be verified and added to the `text-fonts.ts` capability table the same way.
