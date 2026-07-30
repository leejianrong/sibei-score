/**
 * GENERATED FILE — do not edit. Regenerate with `pnpm vendor:bravura`.
 *
 * A slice of Bravura 1.392: the metrics the engraver anchors to, and
 * the outlines of the 15 glyphs it draws. Bravura is SIL OFL 1.1 —
 * see packages/engrave/NOTICE.md. Source: bravura-1.392.
 *
 * Coordinates come in two units and both are Bravura's own, not ours:
 *
 * - metrics — anchors, bounding boxes, advance widths, engraving defaults — are in
 *   **staff spaces**, as SMuFL states them. Layout's unit is a tenth of a staff space,
 *   so a metric reaches layout units by multiplying by `STAFF_SPACE`.
 * - `path` is in **font units**, y-up, exactly as Bravura's SVG font ships it. One
 *   staff space is 250 font units. The engraver places a
 *   glyph by transform rather than by rewriting its path, so the outline stays
 *   byte-identical to the font's and stays auditable.
 */

export const BRAVURA_SOURCE = {
  fontName: 'Bravura',
  fontVersion: '1.392',
  tag: 'bravura-1.392',
} as const;

/** Bravura's em is 1000 units, and SMuFL fixes a staff space at a quarter of the em. */
export const FONT_UNITS_PER_STAFF_SPACE = 250;

/**
 * Bravura's `engravingDefaults`, in staff spaces. These are the thicknesses a
 * from-scratch engraver would otherwise have to invent, and inventing them is how
 * output starts looking subtly amateur (ADR-0030).
 */
export const ENGRAVING_DEFAULTS = {
  staffLineThickness: 0.13,
  stemThickness: 0.12,
  beamThickness: 0.5,
  beamSpacing: 0.25,
  legerLineThickness: 0.16,
  legerLineExtension: 0.4,
} as const;

export interface BravuraGlyph {
  /** SMuFL codepoint, for provenance rather than for drawing. */
  readonly codepoint: string;
  /** Advance width in staff spaces. */
  readonly advance: number;
  readonly bBoxSW: readonly [number, number];
  readonly bBoxNE: readonly [number, number];
  /** SMuFL attachment points, in staff spaces from the glyph's origin, y-up. */
  readonly anchors: Readonly<Record<string, readonly [number, number]>>;
  /** SVG path data in font units, y-up, verbatim from Bravura.svg. */
  readonly path: string;
}

export type BravuraGlyphName = keyof typeof BRAVURA_GLYPHS;

export const BRAVURA_GLYPHS = {
  noteheadWhole: {
    codepoint: 'U+E0A2',
    advance: 1.688,
    bBoxSW: [0, -0.5],
    bBoxNE: [1.688, 0.5],
    anchors: {
      cutOutNW: [0.172, 0.332],
      cutOutSE: [1.532, -0.364],
    },
    path:
      'M216 125c93 0 206 -52 206 -123c0 -70 -52 -127 -216 -127c-149 0 -206 60 -206 127c0 68 83 123 216 123zM111 63c-2 -8 -3 -16 -3 -24c0 -32 15 -66 35 -89c21 -28 58 -52 94 -52c10 0 21 1 31 4c33 8 46 36 46 67c0 60 -55 134 -124 134c-31 0 -68 -5 -79 -40z',
  },
  noteheadHalf: {
    codepoint: 'U+E0A3',
    advance: 1.18,
    bBoxSW: [0, -0.5],
    bBoxNE: [1.18, 0.5],
    anchors: {
      cutOutNW: [0.204, 0.296],
      cutOutSE: [0.98, -0.3],
      splitStemDownNE: [0.956, -0.3],
      splitStemDownNW: [0.128, -0.428],
      splitStemUpSE: [1.108, 0.372],
      splitStemUpSW: [0.328, 0.38],
      stemDownNW: [0, -0.168],
      stemUpSE: [1.18, 0.168],
    },
    path:
      'M97 -125c-55 0 -97 30 -97 83c0 52 47 167 196 167c58 0 99 -32 99 -83c0 -33 -33 -167 -198 -167zM75 -87c48 0 189 88 189 131c0 7 -3 13 -6 19c-7 12 -18 21 -37 21c-47 0 -192 -79 -192 -128c0 -7 3 -14 6 -20c7 -12 19 -23 40 -23z',
  },
  noteheadBlack: {
    codepoint: 'U+E0A4',
    advance: 1.18,
    bBoxSW: [0, -0.5],
    bBoxNE: [1.18, 0.5],
    anchors: {
      cutOutNW: [0.208, 0.3],
      cutOutSE: [0.94, -0.296],
      splitStemDownNE: [0.968, -0.248],
      splitStemDownNW: [0.12, -0.416],
      splitStemUpSE: [1.092, 0.392],
      splitStemUpSW: [0.312, 0.356],
      stemDownNW: [0, -0.168],
      stemUpSE: [1.18, 0.168],
    },
    path:
      'M97 -125c-54 0 -97 31 -97 83c0 86 88 167 198 167c57 0 97 -32 97 -83c0 -85 -109 -167 -198 -167z',
  },
  flag8thUp: {
    codepoint: 'U+E240',
    advance: 1.056,
    bBoxSW: [0, -3.240768470618394],
    bBoxNE: [1.056, 0.03521239682756091],
    anchors: {
      graceNoteSlashNE: [1.284, -0.796],
      graceNoteSlashSW: [-0.644, -2.456],
      stemUpNW: [0, -0.04],
    },
    path:
      'M238 -790c-5 -17 -22 -23 -28 -19s-16 13 -16 29c0 4 1 9 3 15c17 45 24 92 24 137c0 59 -9 116 -24 150c-36 85 -131 221 -197 233v239c0 12 8 15 19 15c10 0 18 -6 21 -22c16 -96 58 -182 109 -261c63 -100 115 -218 115 -343c0 -78 -26 -173 -26 -173z',
  },
  flag8thDown: {
    codepoint: 'U+E241',
    advance: 1.224,
    bBoxSW: [0, -0.0575672],
    bBoxNE: [1.224, 3.232896633157715],
    anchors: {
      graceNoteSlashNW: [-0.596, 2.168],
      graceNoteSlashSE: [1.328, 0.628],
      stemDownSW: [0, 0.132],
    },
    path:
      'M240 760c-10 29 7 48 22 48c7 0 13 -4 16 -15c8 -32 28 -103 28 -181c0 -125 -61 -244 -124 -343c-51 -79 -125 -166 -142 -261c-2 -16 -15 -22 -24 -22c-8 0 -16 5 -16 15v235c134 45 184 126 221 210c15 34 40 118 40 177c0 45 -7 95 -21 137z',
  },
  flag16thUp: {
    codepoint: 'U+E242',
    advance: 1.116,
    bBoxSW: [0, -3.252],
    bBoxNE: [1.116, 0.008],
    anchors: {
      stemUpNW: [0, -0.088],
    },
    path:
      'M272 -796c-6 -13 -13 -17 -20 -17c-14 0 -22 13 -22 26c0 3 0 5 1 9c5 30 8 60 8 89c0 52 -9 101 -32 149c-69 140 -140 142 -202 144h-5v388c0 7 11 10 17 10s18 -2 20 -13c17 -106 73 -122 127 -180c72 -78 98 -106 108 -174c2 -12 3 -23 3 -36 c0 -61 -22 -121 -25 -127c-1 -3 -1 -5 -1 -7c0 -4 1 -6 1 -9c18 -37 29 -78 29 -120v-22c0 -48 -3 -105 -7 -110zM209 -459c2 -3 4 -4 7 -4c5 0 12 3 13 6c5 8 5 18 7 26c1 7 1 13 1 20c0 32 -9 63 -27 89c-33 49 -87 105 -148 105h-8c-8 0 -14 -6 -14 -10c0 -1 0 -2 1 -3 c21 -82 67 -106 114 -160c21 -24 38 -44 54 -69z',
  },
  flag16thDown: {
    codepoint: 'U+E243',
    advance: 1.168,
    bBoxSW: [-0.000019418183745617774, -0.03601094374150052],
    bBoxNE: [1.1635806326044895, 3.2480256],
    anchors: {
      stemDownSW: [0, 0.128],
    },
    path:
      'M240 786c-3 17 5 25 17 26c12 0 19 1 24 -22c16 -80 15 -178 -21 -253c0 -3 -1 -5 -1 -9c0 -3 0 -5 1 -7c3 -6 25 -66 25 -127c0 -13 -1 -25 -3 -36c-24 -157 -221 -200 -245 -354c-2 -11 -13 -13 -20 -13c-10 0 -17 5 -17 10v387h5c62 2 143 5 212 145 c38 78 38 169 23 253zM226 456c-3 0 -5 -1 -7 -4c-16 -26 -33 -46 -54 -69c-47 -55 -103 -78 -124 -160c-1 -1 -1 -2 -1 -3c0 -5 6 -10 14 -10h8c61 0 125 56 158 105c18 26 27 56 27 89c0 6 0 13 -1 20c-2 8 -2 18 -7 25c-1 4 -8 7 -13 7z',
  },
  flag32ndUp: {
    codepoint: 'U+E244',
    advance: 1.048,
    bBoxSW: [0, -3.248],
    bBoxNE: [1.044, 0.596],
    anchors: {
      stemUpNW: [0, 0.376],
    },
    path:
      'M260 -673c0 -9 1 -18 1 -28c0 -43 -4 -89 -7 -95c-7 -11 -14 -16 -20 -16c-2 0 -4 1 -6 2c-7 3 -13 12 -13 24c0 2 1 4 1 7c5 29 8 57 8 85c0 48 -9 93 -31 137c-64 130 -130 132 -188 134h-5v560c0 7 8 12 14 12c10 0 17 -10 18 -19c17 -100 71 -116 121 -170 c67 -73 90 -100 101 -161c2 -9 2 -18 2 -28c0 -39 -11 -80 -20 -106c14 -29 21 -61 21 -93c0 -57 -21 -112 -23 -119c-1 -2 -1 -4 -1 -6c0 -3 0 -5 1 -7c15 -36 24 -74 26 -113zM208 -181c-55 93 -114 117 -169 117c16 -97 65 -114 114 -168c23 -25 41 -44 55 -62 c5 17 10 34 12 44c1 7 3 13 3 21c0 13 -4 28 -15 48zM219 -456c1 8 2 16 2 24c0 81 -90 177 -170 177c-9 0 -14 -9 -12 -16c22 -73 63 -95 106 -146l5 -5c17 -20 31 -37 46 -59c1 -3 4 -4 7 -4c5 0 10 3 11 6c3 7 3 15 5 23z',
  },
  flag32ndDown: {
    codepoint: 'U+E245',
    advance: 1.096,
    bBoxSW: [0, -0.687477099907407],
    bBoxNE: [1.092, 3.248],
    anchors: {
      stemDownSW: [0, -0.448],
    },
    path:
      'M273 676v-11c-4 -64 -9 -75 -22 -100l-4 -7c-2 -3 -3 -5 -3 -9l3 -5v-2c4 -10 20 -53 20 -105c0 -34 -7 -72 -23 -101c9 -27 22 -71 22 -114c0 -10 0 -20 -2 -29c-11 -64 -35 -92 -105 -168c-52 -57 -109 -73 -126 -177c-1 -9 -9 -20 -19 -20c-8 0 -14 4 -14 13v589 c61 2 125 4 201 140c23 41 31 70 31 98c0 34 -12 65 -20 110c0 3 -1 5 -1 7c0 13 7 23 14 26c2 1 4 1 6 1c35 0 42 -116 42 -136zM39 268c0 -5 4 -13 13 -13h5c81 0 173 103 173 185c0 8 -1 17 -2 25c-2 8 -2 16 -5 23c-1 3 -7 6 -12 6c-3 0 -6 -1 -8 -4 c-16 -25 -32 -44 -52 -67c-45 -53 -91 -75 -112 -155zM229 243c-3 11 -8 32 -14 51c-14 -18 -32 -38 -56 -64c-52 -57 -103 -73 -120 -177c0 -1 0 -2 2 -3c57 0 118 26 175 122c12 21 16 37 16 50c0 8 -2 14 -3 21z',
  },
  accidentalDoubleFlat: {
    codepoint: 'U+E264',
    advance: 1.652,
    bBoxSW: [0, -0.7],
    bBoxNE: [1.644, 1.748],
    anchors: {
      cutOutNE: [0.988, 0.644],
      cutOutSE: [1.336, -0.396],
    },
    path:
      'M314 151h6c47 -1 91 -38 91 -94c0 -46 -32 -107 -122 -170c-23 -16 -47 -44 -78 -60c0 0 -3 -2 -6 -2c-2 0 -5 1 -8 5c-3 3 -5 60 -7 135c-19 -24 -47 -51 -84 -77c-23 -17 -48 -45 -79 -61c0 0 -3 -2 -6 -2s-6 1 -9 5c-7 9 -12 581 -12 581c1 17 17 26 31 26 c10 0 19 -5 19 -16c0 -19 -7 -260 -7 -281c0 -8 4 -15 11 -17c2 -1 3 -1 5 -1c9 0 16 9 24 13c16 9 28 16 47 16h6c19 0 36 -6 51 -16c-2 139 -3 276 -3 276c2 17 18 26 31 26c10 0 19 -5 19 -16c0 -19 -6 -260 -6 -281c0 -8 3 -15 10 -17c1 -1 3 -1 5 -1c9 0 17 9 24 13 c16 9 29 16 47 16zM67 -93c45 28 90 78 90 134c0 25 -10 59 -40 59c-24 0 -65 -30 -71 -50c-1 -4 -2 -16 -2 -32c0 -39 3 -98 3 -98c0 -6 3 -16 11 -16c2 0 6 1 9 3zM251 -93c45 28 89 78 89 134c0 20 -6 37 -15 49c-6 7 -14 10 -24 10c-24 0 -66 -30 -72 -50 c-1 -3 -1 -12 -1 -23c0 -38 3 -107 3 -107c0 -6 3 -16 11 -16c2 0 5 1 9 3z',
  },
  accidentalFlat: {
    codepoint: 'U+E260',
    advance: 0.904,
    bBoxSW: [0, -0.7],
    bBoxNE: [0.904, 1.756],
    anchors: {
      cutOutNE: [0.252, 0.656],
      cutOutSE: [0.504, -0.476],
    },
    path:
      'M12 -170c-8 10 -12 581 -12 581c1 18 17 28 31 28c10 0 19 -6 19 -17c0 -20 -6 -260 -7 -282c0 -7 4 -14 11 -17c2 -1 3 -1 5 -1c5 0 16 9 22 14c14 9 38 17 55 17c46 -3 90 -39 90 -96c0 -46 -31 -107 -120 -169c-25 -17 -49 -44 -79 -61c0 0 -3 -2 -6 -2s-6 1 -9 5z M47 -81c0 -5 2 -15 11 -15c3 0 6 1 10 3c43 27 89 81 89 135c0 25 -12 58 -41 58c-23 0 -63 -29 -70 -49c-1 -4 -2 -16 -2 -32c0 -40 3 -100 3 -100z',
  },
  accidentalNatural: {
    codepoint: 'U+E261',
    advance: 0.672,
    bBoxSW: [0, -1.34],
    bBoxNE: [0.672, 1.364],
    anchors: {
      cutOutNE: [0.192, 0.776],
      cutOutSW: [0.476, -0.828],
    },
    path:
      'M141 181l15 5c1 1 3 1 4 1c4 0 8 -3 8 -8v-502c0 -7 -6 -12 -12 -12h-13c-7 0 -12 5 -12 12v149c0 8 -7 11 -17 11c-29 0 -85 -24 -99 -30c-1 -1 -3 -1 -4 -1l-2 -1c-6 0 -9 3 -9 9v515c0 7 5 12 12 12h13c6 0 12 -5 12 -12v-167c0 -4 4 -5 10 -5c26 0 90 23 90 23 c1 0 2 1 4 1zM37 39v-103c0 -4 5 -6 12 -6c25 0 82 23 82 41v103c0 4 -3 5 -9 5c-24 0 -85 -26 -85 -40z',
  },
  accidentalSharp: {
    codepoint: 'U+E262',
    advance: 0.996,
    bBoxSW: [0, -1.392],
    bBoxNE: [0.996, 1.4],
    anchors: {
      cutOutNE: [0.84, 0.896],
      cutOutNW: [0.144, 0.568],
      cutOutSE: [0.84, -0.596],
      cutOutSW: [0.144, -0.896],
    },
    path:
      'M237 118l-26 -10c-8 -3 -13 -22 -13 -29v-93c0 -12 7 -18 13 -18l26 10c2 1 3 1 5 1c4 0 7 -3 7 -8v-71c0 -6 -5 -14 -12 -17c0 0 -21 -8 -28 -11s-11 -15 -11 -23v-142c0 -6 -6 -11 -17 -11c-7 0 -13 5 -13 11v125c0 6 -5 18 -14 18l-2 -1h-1l-61 -25 c-5 -2 -10 -9 -10 -22v-139c0 -6 -7 -11 -17 -11c-7 0 -13 5 -13 11v123c0 5 -5 16 -12 16c-1 0 -2 0 -3 -1c-9 -3 -23 -9 -24 -9l-2 -1c-6 0 -9 3 -9 9v71c0 6 5 14 12 16c0 0 21 9 27 11c6 3 11 12 11 23v99c0 8 -6 18 -14 18l-1 -1c-8 -4 -23 -10 -24 -10l-2 -1 c-6 0 -9 3 -9 9v71c0 6 5 14 12 16c0 0 20 8 26 11s12 13 12 27v135c0 6 6 11 16 11c7 0 14 -5 14 -11v-120c0 -8 3 -20 12 -20c17 4 51 18 63 25c9 6 12 19 13 29v130c0 6 6 11 16 11c8 0 14 -5 14 -11v-122c0 -8 7 -13 14 -13c5 1 25 9 25 9c2 1 3 1 5 1c4 0 7 -3 7 -8 v-71c0 -6 -5 -14 -12 -17zM168 -45c2 9 4 37 4 64s-2 52 -4 57c-2 4 -8 6 -15 6c-25 0 -71 -21 -73 -38c-2 -8 -3 -43 -3 -74c0 -24 1 -46 3 -50c1 -3 6 -5 12 -5c23 0 70 20 76 40z',
  },
  accidentalDoubleSharp: {
    codepoint: 'U+E263',
    advance: 1,
    bBoxSW: [0, -0.5],
    bBoxNE: [0.988, 0.508],
    anchors: {},
    path:
      'M190 -32h10c17 0 35 -2 40 -7c4 -5 7 -23 7 -40c0 -36 -7 -46 -45 -46c-17 0 -33 4 -40 10c-4 3 -5 20 -5 38c-4 14 -21 46 -34 46s-25 -28 -31 -42c-1 -1 -2 -3 -2 -4c0 -16 -2 -33 -8 -38c-6 -7 -22 -10 -37 -10c-17 0 -33 4 -40 10c-3 2 -5 20 -5 38s2 35 5 38 c6 5 25 7 43 7h10c14 5 46 21 46 34c0 7 -36 27 -47 33c-3 0 -6 -1 -10 -1c-17 0 -35 4 -42 10c-3 3 -5 21 -5 39s2 35 5 37c6 5 24 7 41 7c16 0 32 -2 36 -7c5 -4 8 -22 8 -39c4 -14 20 -47 34 -47c12 0 28 36 33 47c0 18 1 36 5 39c5 5 23 7 41 7c41 0 44 -6 44 -47 c0 -16 -2 -31 -7 -36c-10 -8 -29 -10 -41 -10l-6 1h-3c-14 -5 -47 -20 -47 -34c0 -7 36 -27 47 -33z',
  },
  augmentationDot: {
    codepoint: 'U+E1E7',
    advance: 0.4,
    bBoxSW: [0, -0.2],
    bBoxNE: [0.4, 0.2],
    anchors: {},
    path:
      'M100 0c0 -28 -22 -50 -50 -50s-50 22 -50 50s22 50 50 50s50 -22 50 -50z',
  },
} as const satisfies Record<string, BravuraGlyph>;
