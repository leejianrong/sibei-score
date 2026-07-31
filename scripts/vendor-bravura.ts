/**
 * Vendor the slice of Bravura the engraver needs, as generated source.
 *
 *   pnpm vendor:bravura              fetch from the pinned tag and regenerate
 *   pnpm vendor:bravura --from DIR   use files already downloaded into DIR
 *   pnpm vendor:bravura --check      regenerate into memory and diff, writing nothing
 *
 * Why generate rather than depend. Bravura publishes no npm package, and the product
 * has to build and render offline (ADR-0027), so the alternatives are a checked-in
 * subset or a network fetch at install time. The subset is 15 glyphs and one table of
 * engraving defaults — a few kilobytes — and checking it in keeps `pnpm install`
 * offline, keeps the lockfile free of a font, and makes the data auditable in review.
 *
 * Why three sources. They are the three halves of the same fact and they cross-check
 * each other:
 *
 *   bravura_metadata.json   anchors (`stemUpSE`), bounding boxes, advance widths, and
 *                           `engravingDefaults` — the metrics, in staff spaces
 *   Bravura.svg             the outlines themselves, as SVG path data in font units.
 *                           An SVG font needs no font parser to read, which is why it
 *                           is the source here rather than the .otf
 *   glyphnames.json         SMuFL's canonical name-to-codepoint map, so no codepoint
 *                           is transcribed by hand
 *
 * Every glyph is checked across two of them before it is written: the advance width
 * the metadata states, in staff spaces, must equal the advance width the SVG font
 * states, in font units. A codepoint that resolved to the wrong glyph fails there.
 *
 * Bravura is SIL OFL 1.1 (see packages/engrave/NOTICE.md). SMuFL's glyphnames.json is
 * read at vendoring time only and is not redistributed.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Pinned, so regenerating twice gives the same bytes. */
const BRAVURA_TAG = 'bravura-1.392';
const SMUFL_REF = 'gh-pages';

const SOURCES = {
  metadata: `https://raw.githubusercontent.com/steinbergmedia/bravura/${BRAVURA_TAG}/redist/bravura_metadata.json`,
  svgFont: `https://raw.githubusercontent.com/steinbergmedia/bravura/${BRAVURA_TAG}/redist/svg/Bravura.svg`,
  glyphNames: `https://raw.githubusercontent.com/w3c/smufl/${SMUFL_REF}/metadata/glyphnames.json`,
} as const;

const LOCAL_NAMES: Record<keyof typeof SOURCES, string> = {
  metadata: 'bravura_metadata.json',
  svgFont: 'Bravura.svg',
  glyphNames: 'glyphnames.json',
};

const OUTPUT = resolve('packages/engrave/src/fonts/bravura.generated.ts');

/**
 * The glyphs the engraver draws. Everything else it needs — stems, beams, ledger and
 * staff lines — is a rectangle whose size comes from `engravingDefaults`, which is a
 * large part of why owning this is affordable.
 */
const GLYPHS = [
  'noteheadWhole',
  'noteheadHalf',
  'noteheadBlack',
  'flag8thUp',
  'flag8thDown',
  'flag16thUp',
  'flag16thDown',
  'flag32ndUp',
  'flag32ndDown',
  'accidentalDoubleFlat',
  'accidentalFlat',
  'accidentalNatural',
  'accidentalSharp',
  'accidentalDoubleSharp',
  'augmentationDot',
] as const;

/** The defaults the engraver reads. Named rather than copied wholesale, so the file says what is used. */
const DEFAULTS = [
  'staffLineThickness',
  'stemThickness',
  'beamThickness',
  'beamSpacing',
  'legerLineThickness',
  'legerLineExtension',
] as const;

// ---------------------------------------------------------------------------
// The source documents
// ---------------------------------------------------------------------------

interface BravuraMetadata {
  fontName: string;
  fontVersion: number | string;
  engravingDefaults: Record<string, unknown>;
  glyphAdvanceWidths: Record<string, number>;
  glyphBBoxes: Record<string, { bBoxNE: [number, number]; bBoxSW: [number, number] }>;
  glyphsWithAnchors: Record<string, Record<string, [number, number]>>;
}

type GlyphNames = Record<string, { codepoint: string }>;

interface SvgGlyph {
  advance: number;
  path: string;
}

async function load(from: string | null): Promise<{
  metadata: BravuraMetadata;
  svgFont: string;
  glyphNames: GlyphNames;
}> {
  const text = async (key: keyof typeof SOURCES): Promise<string> => {
    if (from !== null) {
      const path = resolve(from, LOCAL_NAMES[key]);
      if (!existsSync(path)) throw new Error(`--from ${from} has no ${LOCAL_NAMES[key]}`);
      return readFileSync(path, 'utf8');
    }
    const response = await fetch(SOURCES[key]);
    if (!response.ok) throw new Error(`${SOURCES[key]} -> HTTP ${response.status}`);
    return await response.text();
  };

  const [metadata, svgFont, glyphNames] = await Promise.all([
    text('metadata'),
    text('svgFont'),
    text('glyphNames'),
  ]);

  return {
    metadata: JSON.parse(metadata) as BravuraMetadata,
    svgFont,
    glyphNames: JSON.parse(glyphNames) as GlyphNames,
  };
}

/**
 * Pull one glyph out of the SVG font. An SVG font is a flat list of `<glyph>` elements
 * keyed by `glyph-name`, so this is a lookup rather than a parse — no font library, and
 * the outline arrives as the path data an SVG can use unchanged.
 */
function svgGlyph(font: string, glyphName: string): SvgGlyph {
  const pattern = new RegExp(
    `<glyph glyph-name="${glyphName}"\\s+unicode="[^"]*"\\s+horiz-adv-x="(-?\\d+)"\\s*d="([^"]*)"`,
    's',
  );
  const match = pattern.exec(font);
  if (match === null) throw new Error(`Bravura.svg has no glyph named ${glyphName}`);
  const [, advance, path] = match;
  if (advance === undefined || path === undefined) throw new Error(`malformed glyph ${glyphName}`);
  // Path data is wrapped across lines in the source file; an SVG attribute does not care,
  // but a single line keeps the generated file diffable.
  return { advance: Number(advance), path: path.replace(/\s+/g, ' ').trim() };
}

function codepointOf(glyphNames: GlyphNames, name: string): string {
  const entry = glyphNames[name];
  if (entry === undefined) throw new Error(`${name} is not a SMuFL glyph name`);
  return entry.codepoint;
}

/** SMuFL codepoint `U+E0A4` to the `glyph-name` an SVG font uses. */
function svgGlyphName(codepoint: string): string {
  return `uni${codepoint.slice(2).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Generating
// ---------------------------------------------------------------------------

/** Bravura's em is 1000 units and its staff space is a quarter of that (SMuFL). */
const FONT_UNITS_PER_STAFF_SPACE = 250;

function generate(sources: {
  metadata: BravuraMetadata;
  svgFont: string;
  glyphNames: GlyphNames;
}): string {
  const { metadata, svgFont, glyphNames } = sources;

  const defaults = DEFAULTS.map((key) => {
    const value = metadata.engravingDefaults[key];
    if (typeof value !== 'number') {
      throw new Error(`engravingDefaults.${key} is not a number: ${JSON.stringify(value)}`);
    }
    return [key, value] as const;
  });

  const glyphs = GLYPHS.map((name) => {
    const codepoint = codepointOf(glyphNames, name);
    const outline = svgGlyph(svgFont, svgGlyphName(codepoint));
    const advance = metadata.glyphAdvanceWidths[name];
    const bbox = metadata.glyphBBoxes[name];
    if (advance === undefined || bbox === undefined) {
      throw new Error(`bravura_metadata.json has no metrics for ${name}`);
    }

    // The cross-check. Two independent files, one fact: if the codepoint resolved to
    // the wrong glyph, or the two files are from different releases, these disagree.
    const expected = Math.round(advance * FONT_UNITS_PER_STAFF_SPACE);
    if (outline.advance !== expected) {
      throw new Error(
        `${name} (${codepoint}): metadata says ${advance} staff spaces (${expected} font ` +
          `units), Bravura.svg says ${outline.advance}`,
      );
    }

    return {
      name,
      codepoint,
      advance,
      bbox,
      anchors: metadata.glyphsWithAnchors[name] ?? {},
      path: outline.path,
    };
  });

  const anchorEntries = (anchors: Record<string, [number, number]>, indent: number): string => {
    const keys = Object.keys(anchors).sort();
    if (keys.length === 0) return '{}';
    const pad = ' '.repeat(indent + 2);
    const body = keys
      .map((key) => `${pad}${key}: [${anchors[key]?.[0]}, ${anchors[key]?.[1]}],`)
      .join('\n');
    return `{\n${body}\n${' '.repeat(indent)}}`;
  };

  const glyphBody = glyphs
    .map(
      (glyph) => `    ${glyph.name}: {
      codepoint: '${glyph.codepoint}',
      advance: ${glyph.advance},
      bBoxSW: [${glyph.bbox.bBoxSW[0]}, ${glyph.bbox.bBoxSW[1]}],
      bBoxNE: [${glyph.bbox.bBoxNE[0]}, ${glyph.bbox.bBoxNE[1]}],
      anchors: ${anchorEntries(glyph.anchors, 6)},
      path:
        '${glyph.path}',
    },`,
    )
    .join('\n');

  return `import type { MusicFontData } from '../font.js';

/**
 * GENERATED FILE — do not edit. Regenerate with \`pnpm vendor:bravura\`.
 *
 * A slice of Bravura ${metadata.fontVersion}: the metrics the engraver anchors to, and
 * the outlines of the ${glyphs.length} glyphs it draws. Bravura is SIL OFL 1.1 —
 * see packages/engrave/NOTICE.md. Source: ${BRAVURA_TAG}.
 *
 * Coordinates come in two units and both are Bravura's own, not ours:
 *
 * - metrics — anchors, bounding boxes, advance widths, engraving defaults — are in
 *   **staff spaces**, as SMuFL states them. Layout's unit is a tenth of a staff space,
 *   so a metric reaches layout units by multiplying by \`STAFF_SPACE\`.
 * - \`path\` is in **font units**, y-up, exactly as Bravura's SVG font ships it. One
 *   staff space is ${FONT_UNITS_PER_STAFF_SPACE} font units. The engraver places a
 *   glyph by transform rather than by rewriting its path, so the outline stays
 *   byte-identical to the font's and stays auditable.
 *
 * \`satisfies MusicFontData\` is load-bearing: it fails the build if this face is missing
 * a glyph the engraver draws, which is what stops a second font being half a font.
 */
export const BRAVURA = {
  name: '${metadata.fontName}',
  version: '${metadata.fontVersion}',
  source: '${BRAVURA_TAG}',
  /** Bravura's em is 1000 units, and SMuFL fixes a staff space at a quarter of the em. */
  fontUnitsPerStaffSpace: ${FONT_UNITS_PER_STAFF_SPACE},
  engravingDefaults: {
${defaults.map(([key, value]) => `    ${key}: ${value},`).join('\n')}
  },
  glyphs: {
${glyphBody}
  },
} as const satisfies MusicFontData;
`;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  let from: string | null = null;
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--from') from = argv[(i += 1)] ?? null;
    else if (argv[i] === '--check') check = true;
    else throw new Error(`unknown argument: ${String(argv[i])}`);
  }

  const generated = generate(await load(from));

  if (check) {
    const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
    if (current === generated) {
      process.stdout.write('bravura.generated.ts is up to date\n');
      return 0;
    }
    process.stderr.write(
      'bravura.generated.ts differs from what the sources produce. Run pnpm vendor:bravura.\n',
    );
    return 1;
  }

  writeFileSync(OUTPUT, generated);
  process.stdout.write(
    `wrote ${OUTPUT}\n  ${GLYPHS.length} glyphs and ${DEFAULTS.length} engraving defaults ` +
      `from ${BRAVURA_TAG}\n`,
  );
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
    process.exit(1);
  },
);
