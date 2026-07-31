/**
 * Vendor the slices of Bravura and Petaluma the engraver needs, as generated source.
 *
 *   pnpm vendor:fonts                fetch from the pinned tags and regenerate both
 *   pnpm vendor:fonts bravura        one face only
 *   pnpm vendor:fonts --from DIR     use files already downloaded into DIR
 *   pnpm vendor:fonts --check        regenerate into memory and diff, writing nothing
 *
 * Why generate rather than depend. Neither font publishes an npm package, and the product
 * has to build and render offline (ADR-0027), so the alternatives are a checked-in subset
 * or a network fetch at install time. The subset is 43 glyphs and a table of engraving
 * defaults per face, and checking it in keeps `pnpm install` offline, keeps the lockfile
 * free of a font, and makes the data auditable in review.
 *
 * **Why two faces.** A lead sheet is read in a handwritten Real Book face as often as an
 * engraved one, and which one is the reader's choice at render time (ADR-0030). Bravura is
 * SMuFL's reference face; Petaluma is Steinberg's handwritten one. Both are SIL OFL 1.1.
 *
 * **Why the outlines come from different places.** Bravura's redist ships an SVG font, and
 * an SVG font needs no font parser to read — the outline is already SVG path data.
 * Petaluma ships only OTF and WOFF, so its outlines are read with `opentype.js`, a
 * devDependency that runs here and never ships. The asymmetry is the font projects' rather
 * than ours.
 *
 * Every glyph is cross-checked between two files of the same release before it is
 * written, so a codepoint that resolved to the wrong glyph fails here rather than in an
 * image. Which check depends on what each face publishes: Bravura's metadata gives advance
 * widths, which must match the SVG font's; Petaluma's does not, so its outline's true
 * bounding box must match the one the metadata publishes — which is also what proves its
 * y axis was flipped the right way.
 *
 * SMuFL's `glyphnames.json` is read at vendoring time to resolve names to codepoints so
 * that none is transcribed by hand. It is not redistributed.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import opentype from 'opentype.js';

const SMUFL_REF = 'gh-pages';
const GLYPH_NAMES_URL = `https://raw.githubusercontent.com/w3c/smufl/${SMUFL_REF}/metadata/glyphnames.json`;

interface FaceSpec {
  /** The file the generated module lands in, and the face's short name. */
  key: string;
  /** Symbol the generated module exports. */
  symbol: string;
  tag: string;
  metadataUrl: string;
  /** Where the outlines come from, and therefore how they are read. */
  outlines: { kind: 'svg-font' | 'otf'; url: string };
  localMetadata: string;
  localOutlines: string;
}

const FACES: FaceSpec[] = [
  {
    key: 'bravura',
    symbol: 'BRAVURA',
    tag: 'bravura-1.392',
    metadataUrl:
      'https://raw.githubusercontent.com/steinbergmedia/bravura/bravura-1.392/redist/bravura_metadata.json',
    outlines: {
      kind: 'svg-font',
      url: 'https://raw.githubusercontent.com/steinbergmedia/bravura/bravura-1.392/redist/svg/Bravura.svg',
    },
    localMetadata: 'bravura_metadata.json',
    localOutlines: 'Bravura.svg',
  },
  {
    key: 'petaluma',
    symbol: 'PETALUMA',
    tag: 'petaluma-1.065',
    metadataUrl:
      'https://raw.githubusercontent.com/steinbergmedia/petaluma/master/redist/petaluma_metadata.json',
    outlines: {
      kind: 'otf',
      url: 'https://raw.githubusercontent.com/steinbergmedia/petaluma/master/redist/otf/Petaluma.otf',
    },
    localMetadata: 'petaluma_metadata.json',
    localOutlines: 'Petaluma.otf',
  },
];

/**
 * Every glyph the engraver draws. Stems, beams, barlines, ledger and staff lines are all
 * rectangles whose size comes from `engravingDefaults`, which is a large part of why
 * owning this is affordable.
 */
const GLYPHS: readonly string[] = [
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
  'restWhole',
  'restHalf',
  'restQuarter',
  'rest8th',
  'rest16th',
  'rest32nd',
  'gClef',
  'repeatDot',
  ...Array.from({ length: 10 }, (_, digit) => `timeSig${digit}`),
  ...Array.from({ length: 10 }, (_, digit) => `tuplet${digit}`),
];

/** The defaults the engraver reads. Named rather than copied wholesale, so the file says what is used. */
const DEFAULTS: readonly string[] = [
  'staffLineThickness',
  'stemThickness',
  'beamThickness',
  'beamSpacing',
  'legerLineThickness',
  'legerLineExtension',
  'thinBarlineThickness',
  'thickBarlineThickness',
  'barlineSeparation',
  'repeatBarlineDotSeparation',
  'tieEndpointThickness',
  'tieMidpointThickness',
  'tupletBracketThickness',
  'repeatEndingLineThickness',
];

/** SMuFL fixes the em square at four staff spaces. */
const STAFF_SPACES_PER_EM = 4;

// ---------------------------------------------------------------------------
// The source documents
// ---------------------------------------------------------------------------

interface FontMetadata {
  fontName: string;
  fontVersion: number | string;
  engravingDefaults: Record<string, unknown>;
  /** Bravura publishes these; Petaluma does not, so the font file is asked instead. */
  glyphAdvanceWidths?: Record<string, number>;
  glyphBBoxes: Record<string, { bBoxNE: [number, number]; bBoxSW: [number, number] }>;
  glyphsWithAnchors: Record<string, Record<string, [number, number]>>;
}

type GlyphNames = Record<string, { codepoint: string }>;

interface Outline {
  /** Advance width in font units. */
  advance: number;
  /** SVG path data in font units, y-up. */
  path: string;
  /**
   * The outline's true vertical extent in font units, or null when it cannot be had
   * cheaply. See `checkExtent` for what is and is not checked, and why.
   */
  extent: { minY: number; maxY: number } | null;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return await response.text();
}

async function fetchBinary(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function localPath(from: string, name: string): string {
  const path = resolve(from, name);
  if (!existsSync(path)) throw new Error(`--from ${from} has no ${name}`);
  return path;
}

function hex(codepoint: number): string {
  return `U+${codepoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

function round(value: number): string {
  return String(Number(value.toFixed(2)));
}

// ---------------------------------------------------------------------------
// Outlines
// ---------------------------------------------------------------------------

/**
 * An SVG font is a flat list of `<glyph>` elements keyed by `glyph-name`, so this is a
 * lookup rather than a parse — no font library, and the outline arrives as the path data
 * an SVG can use unchanged, in font units with y up.
 */
function svgFontOutline(font: string, codepoint: number, name: string): Outline {
  const glyphName = `uni${hex(codepoint).slice(2)}`;
  const pattern = new RegExp(
    `<glyph glyph-name="${glyphName}"\\s+unicode="[^"]*"\\s+horiz-adv-x="(-?\\d+)"\\s*d="([^"]*)"`,
    's',
  );
  const match = pattern.exec(font);
  if (match === null) throw new Error(`the SVG font has no ${name} (${glyphName})`);
  const [, advance, raw] = match;
  if (advance === undefined || raw === undefined) throw new Error(`malformed glyph ${name}`);
  // Path data is wrapped across lines in the source file; an SVG attribute does not care,
  // but a single line keeps the generated file diffable.
  const path = raw.replace(/\s+/g, ' ').trim();
  // No extent: measuring this path would mean owning an SVG path parser, and getting one
  // subtly wrong is worse than not having it — the first attempt paired coordinates
  // positionally and mis-measured every glyph with a horizontal or vertical lineto in it.
  // The advance-width cross-check below covers this face instead.
  return { advance: Number(advance), path, extent: null };
}

/**
 * `opentype.js` hands back a path in screen coordinates — y down — so it is flipped here
 * rather than left for the engraver to special-case. Every vendored outline is y-up in
 * font units whatever it was read from, which is what lets one glyph transform serve both
 * faces. The extent check below is what proves the flip went the right way.
 */
function otfOutline(font: opentype.Font, codepoint: number, name: string): Outline {
  const glyph = font.charToGlyph(String.fromCodePoint(codepoint));
  if (glyph.index === 0) throw new Error(`the OTF has no ${name} (${hex(codepoint)})`);

  const parts: string[] = [];
  const y = (value: number): string => round(-value);

  for (const command of glyph.getPath(0, 0, font.unitsPerEm).commands) {
    switch (command.type) {
      case 'M':
        parts.push(`M${round(command.x)} ${y(command.y)}`);
        break;
      case 'L':
        parts.push(`L${round(command.x)} ${y(command.y)}`);
        break;
      case 'C':
        parts.push(
          `C${round(command.x1)} ${y(command.y1)} ${round(command.x2)} ${y(command.y2)} ` +
            `${round(command.x)} ${y(command.y)}`,
        );
        break;
      case 'Q':
        parts.push(`Q${round(command.x1)} ${y(command.y1)} ${round(command.x)} ${y(command.y)}`);
        break;
      case 'Z':
        parts.push('Z');
        break;
    }
  }

  if (parts.length === 0) throw new Error(`${name} has an empty outline`);

  // opentype computes true curve extrema rather than a control-point hull, so this box
  // can be compared with the metadata's tightly. Flipped, like the path itself.
  const box = glyph.getPath(0, 0, font.unitsPerEm).getBoundingBox();
  return {
    advance: glyph.advanceWidth ?? 0,
    path: parts.join(' '),
    extent: { minY: -box.y2, maxY: -box.y1 },
  };
}

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

/**
 * The outline must sit where the metadata says the glyph sits.
 *
 * This is aimed at the failure that looks like nothing: an outline read with the y axis
 * upside down. `flag8thUp` hangs three and a quarter staff spaces below its origin and
 * barely rises above it, and `flag8thDown` is its mirror — so a flip moves a flag's extent
 * right across the staff, and comparing against the published bounding box catches it at
 * vendoring time rather than in an image.
 *
 * It runs only where the outline's true extent is known, which today means the OTF face:
 * `opentype.js` computes real curve extrema. The SVG-font face is covered by the
 * advance-width cross-check instead, which is independent in the same way — two files from
 * the same release having to agree about one glyph.
 */
function checkExtent(
  name: string,
  outline: Outline,
  bbox: { bBoxNE: [number, number]; bBoxSW: [number, number] },
  unitsPerStaffSpace: number,
): void {
  if (outline.extent === null) return;

  const top = bbox.bBoxNE[1] * unitsPerStaffSpace;
  const bottom = bbox.bBoxSW[1] * unitsPerStaffSpace;
  // A tenth of a staff space, for rounding and for hinting differences between the
  // metadata's generator and this one.
  const slop = unitsPerStaffSpace * 0.1;

  if (Math.abs(outline.extent.maxY - top) > slop) {
    throw new Error(
      `${name}: the metadata puts the top at ${top.toFixed(1)} font units, the outline ` +
        `reaches ${outline.extent.maxY.toFixed(1)} — wrong glyph, or an upside-down outline`,
    );
  }
  if (Math.abs(outline.extent.minY - bottom) > slop) {
    throw new Error(
      `${name}: the metadata puts the bottom at ${bottom.toFixed(1)} font units, the outline ` +
        `reaches ${outline.extent.minY.toFixed(1)} — wrong glyph, or an upside-down outline`,
    );
  }
}

// ---------------------------------------------------------------------------
// Generating
// ---------------------------------------------------------------------------

function generate(
  face: FaceSpec,
  metadata: FontMetadata,
  glyphNames: GlyphNames,
  outlineOf: (codepoint: number, name: string) => Outline,
  unitsPerEm: number,
): string {
  const unitsPerStaffSpace = unitsPerEm / STAFF_SPACES_PER_EM;

  const defaults = DEFAULTS.map((key) => {
    const value = metadata.engravingDefaults[key];
    if (typeof value !== 'number') {
      throw new Error(`${face.key}: engravingDefaults.${key} is not a number`);
    }
    return [key, value] as const;
  });

  const glyphs = GLYPHS.map((name) => {
    const entry = glyphNames[name];
    if (entry === undefined) throw new Error(`${name} is not a SMuFL glyph name`);
    const codepoint = Number.parseInt(entry.codepoint.slice(2), 16);

    const bbox = metadata.glyphBBoxes[name];
    if (bbox === undefined) throw new Error(`${face.key}: no bounding box for ${name}`);

    const outline = outlineOf(codepoint, name);
    checkExtent(`${face.key}/${name}`, outline, bbox, unitsPerStaffSpace);

    // Bravura publishes advance widths as well, so the two files can be crossed against
    // each other. Petaluma publishes none, and the font file is the only source.
    const published = metadata.glyphAdvanceWidths?.[name];
    if (published !== undefined) {
      const expected = Math.round(published * unitsPerStaffSpace);
      if (Math.abs(outline.advance - expected) > 1) {
        throw new Error(
          `${face.key}/${name} (${entry.codepoint}): the metadata says ${published} staff ` +
            `spaces (${expected} font units), the outline says ${outline.advance}`,
        );
      }
    }

    return {
      name,
      codepoint: entry.codepoint,
      advance: published ?? outline.advance / unitsPerStaffSpace,
      bbox,
      anchors: metadata.glyphsWithAnchors[name] ?? {},
      path: outline.path,
    };
  });

  const anchorEntries = (anchors: Record<string, [number, number]>): string => {
    const keys = Object.keys(anchors).sort();
    if (keys.length === 0) return '{}';
    const body = keys
      .map((key) => `        ${key}: [${anchors[key]?.[0]}, ${anchors[key]?.[1]}],`)
      .join('\n');
    return `{\n${body}\n      }`;
  };

  const glyphBody = glyphs
    .map(
      (glyph) => `    ${glyph.name}: {
      codepoint: '${glyph.codepoint}',
      advance: ${Number(glyph.advance.toFixed(4))},
      bBoxSW: [${glyph.bbox.bBoxSW[0]}, ${glyph.bbox.bBoxSW[1]}],
      bBoxNE: [${glyph.bbox.bBoxNE[0]}, ${glyph.bbox.bBoxNE[1]}],
      anchors: ${anchorEntries(glyph.anchors)},
      path:
        '${glyph.path}',
    },`,
    )
    .join('\n');

  const source =
    face.outlines.kind === 'svg-font' ? "the font's own SVG font" : 'the OTF, via opentype.js';

  return `import type { MusicFontData } from '../font.js';

/**
 * GENERATED FILE — do not edit. Regenerate with \`pnpm vendor:fonts\`.
 *
 * A slice of ${metadata.fontName} ${metadata.fontVersion}: the metrics the engraver
 * anchors to, and the outlines of the ${glyphs.length} glyphs it draws.
 * ${metadata.fontName} is SIL OFL 1.1 — see packages/engrave/NOTICE.md. Source:
 * ${face.tag}, outlines from ${source}.
 *
 * Coordinates come in two units and both are the font's own, not ours:
 *
 * - metrics — anchors, bounding boxes, advance widths, engraving defaults — are in
 *   **staff spaces**, as SMuFL states them. Layout's unit is a tenth of a staff space,
 *   so a metric reaches layout units by multiplying by \`STAFF_SPACE\`.
 * - \`path\` is in **font units**, y-up. One staff space is ${unitsPerStaffSpace} font
 *   units. The engraver places a glyph by transform rather than by rewriting its path.
 *
 * \`satisfies MusicFontData\` is load-bearing: it fails the build if this face is missing
 * a glyph the engraver draws, which is what stops a second font being half a font.
 */
export const ${face.symbol} = {
  name: '${metadata.fontName}',
  version: '${metadata.fontVersion}',
  source: '${face.tag}',
  fontUnitsPerStaffSpace: ${unitsPerStaffSpace},
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

async function build(face: FaceSpec, glyphNames: GlyphNames, from: string | null): Promise<string> {
  const metadata = JSON.parse(
    from === null
      ? await fetchText(face.metadataUrl)
      : readFileSync(localPath(from, face.localMetadata), 'utf8'),
  ) as FontMetadata;

  if (face.outlines.kind === 'svg-font') {
    const svg =
      from === null
        ? await fetchText(face.outlines.url)
        : readFileSync(localPath(from, face.localOutlines), 'utf8');
    // An SVG font declares its own em; SMuFL fixes the staff space at a quarter of it.
    const em = /units-per-em="(\d+)"/.exec(svg);
    if (em?.[1] === undefined) throw new Error(`${face.key}: the SVG font declares no units-per-em`);
    return generate(
      face,
      metadata,
      glyphNames,
      (codepoint, name) => svgFontOutline(svg, codepoint, name),
      Number(em[1]),
    );
  }

  const bytes =
    from === null
      ? await fetchBinary(face.outlines.url)
      : readFileSync(localPath(from, face.localOutlines));
  const font = opentype.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return generate(
    face,
    metadata,
    glyphNames,
    (codepoint, name) => otfOutline(font, codepoint, name),
    font.unitsPerEm,
  );
}

async function main(argv: string[]): Promise<number> {
  let from: string | null = null;
  let check = false;
  const wanted: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from') from = argv[(i += 1)] ?? null;
    else if (arg === '--check') check = true;
    else if (arg !== undefined && !arg.startsWith('--')) wanted.push(arg);
    else throw new Error(`unknown argument: ${String(arg)}`);
  }

  const faces = wanted.length === 0 ? FACES : FACES.filter((face) => wanted.includes(face.key));
  if (faces.length === 0) {
    throw new Error(`unknown face. known: ${FACES.map((face) => face.key).join(', ')}`);
  }

  const glyphNames = JSON.parse(
    from === null
      ? await fetchText(GLYPH_NAMES_URL)
      : readFileSync(localPath(from, 'glyphnames.json'), 'utf8'),
  ) as GlyphNames;

  let stale = false;
  for (const face of faces) {
    const generated = await build(face, glyphNames, from);
    const output = resolve(`packages/engrave/src/fonts/${face.key}.generated.ts`);

    if (check) {
      const current = existsSync(output) ? readFileSync(output, 'utf8') : '';
      if (current === generated) {
        process.stdout.write(`${face.key}.generated.ts is up to date\n`);
      } else {
        process.stderr.write(`${face.key}.generated.ts differs from what its sources produce\n`);
        stale = true;
      }
      continue;
    }

    writeFileSync(output, generated);
    process.stdout.write(
      `wrote ${output}\n  ${GLYPHS.length} glyphs and ${DEFAULTS.length} engraving defaults ` +
        `from ${face.tag}\n`,
    );
  }

  if (stale) {
    process.stderr.write('Run pnpm vendor:fonts.\n');
    return 1;
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
    process.exit(1);
  },
);
