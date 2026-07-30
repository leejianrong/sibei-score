/**
 * Proofing: turn rendered artefacts into images an agent or a person can actually look
 * at, and say what changed.
 *
 * The problem this solves. Engraving defects are visual, and neither the test suite nor
 * a diff catches them: 82 green tests and a passing snapshot coexisted happily with
 * every beamed note drawing a stray flag *and* a doubled stem. Someone had to look. But
 * looking is only useful if it is cheap, repeatable, and aimed — squinting at a whole A4
 * page finds nothing, whereas "show me bar 11 at 4x" finds it immediately.
 *
 * So: crops are named after musical structure, not pixel coordinates. Layout already
 * knows where every system and every bar sits, so `--bar 11` is exact rather than
 * guessed, and the zoom is chosen for you so the output lands at a readable size.
 *
 *   pnpm proof                              every fixture, whole pages
 *   pnpm proof nasty-chart --system 2       one system, zoomed to fit
 *   pnpm proof nasty-chart --bar 11         one bar, with a little context
 *   pnpm proof nasty-chart --systems        every system as its own image
 *   pnpm proof nasty-chart --census         what the SVG contains, vs the snapshot
 *   pnpm proof nasty-chart --pdf            proof the PDF itself, not just the SVG
 *
 * Every run prints a manifest of what it wrote and what each image shows, so the next
 * step — opening the right file — needs no guesswork.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { everyGlyphChart, beamingChart, invalidBarChart, nastyChart } from '@sibei/fixtures';
import type { LayoutResult, Paper } from '@sibei/layout';
import { layout } from '@sibei/layout';
import type { Score } from '@sibei/model';
import { renderScoreToPdf, renderScoreToSvg } from '@sibei/pdf';

const FIXTURES: Record<string, () => Score> = {
  'nasty-chart': nastyChart,
  'every-glyph': everyGlyphChart,
  beaming: beamingChart,
  'invalid-bars': invalidBarChart,
};

const PROOF_DIR = resolve('out/proof');

/** Wide enough to read a semiquaver beam, small enough that a reader keeps the detail. */
const TARGET_WIDTH = 1500;

/** Breathing room around a crop, in layout units, so an edge case is not cut in half. */
const CROP_PAD = 16;

interface Crop {
  name: string;
  what: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Manifest {
  fixture: string;
  images: { file: string; shows: string; zoom: number }[];
}

// ---------------------------------------------------------------------------
// Crops, named after the music rather than the pixels
// ---------------------------------------------------------------------------

function wholePage(result: LayoutResult, pageIndex: number): Crop {
  const page = result.pages[pageIndex];
  if (page === undefined) throw new Error(`no page ${pageIndex}`);
  return {
    name: `page${pageIndex + 1}`,
    what: `the whole of page ${pageIndex + 1}`,
    x: 0,
    y: 0,
    width: page.width,
    height: page.height,
  };
}

function systemCrop(result: LayoutResult, index: number): Crop {
  const systems = result.pages.flatMap((page) => page.systems);
  const system = systems[index - 1];
  if (system === undefined) {
    throw new Error(`no system ${index}; this score has ${systems.length}`);
  }
  const bars = system.bars.map((bar) => bar.barNumber).join(', ');
  return {
    name: `system${index}`,
    what: `system ${index} — bars ${bars}`,
    x: system.x - CROP_PAD,
    y: system.y - CROP_PAD,
    width: system.width + CROP_PAD * 2,
    height: system.height + CROP_PAD * 2,
  };
}

function barCrop(result: LayoutResult, barNumber: number): Crop {
  for (const page of result.pages) {
    for (const system of page.systems) {
      const bar = system.bars.find((candidate) => candidate.barNumber === barNumber);
      if (bar === undefined) continue;
      return {
        name: `bar${barNumber}`,
        what: `bar ${barNumber} (${bar.metrics.status}), in the system holding bars ${system.bars
          .map((b) => b.barNumber)
          .join(', ')}`,
        x: bar.x - CROP_PAD * 2,
        y: system.y - CROP_PAD,
        width: bar.width + CROP_PAD * 4,
        height: system.height + CROP_PAD * 2,
      };
    }
  }
  throw new Error(`no bar ${barNumber} in this score`);
}

// ---------------------------------------------------------------------------
// Rasterising
// ---------------------------------------------------------------------------

function rasterise(svg: string, crop: Crop): { png: Buffer; zoom: number } {
  const zoom = clamp(TARGET_WIDTH / crop.width, 0.5, 8);
  const framed = svg
    .replace(/viewBox="[^"]*"/, `viewBox="${crop.x} ${crop.y} ${crop.width} ${crop.height}"`)
    .replace(/\swidth="[^"]*"/, ` width="${crop.width}"`)
    .replace(/\sheight="[^"]*"/, ` height="${crop.height}"`);

  const png = new Resvg(framed, {
    background: 'white',
    fitTo: { mode: 'zoom', value: zoom },
  })
    .render()
    .asPng();

  return { png: Buffer.from(png), zoom };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Proofing the PDF needs a PDF rasteriser, and nothing is committed for the job: the
 * capable ones are mostly copyleft (poppler GPL, mupdf and ghostscript AGPL) and
 * ADR-0027 keeps this project's dependency register permissive. A rasteriser used to
 * look at output is a separate program, not something linked into the product, so
 * installing one locally carries no obligation either way — but it does not belong in
 * the lockfile.
 *
 * So: use whatever the machine already has, cheapest first, and say plainly when it has
 * nothing. Installed binaries come before `uvx`, which reaches the network the first time
 * it runs — but `uvx` is the one to recommend to someone with nothing, because PDFium is
 * BSD/Apache and needs no root.
 *
 * Little is lost when none is present. The PDF is a conversion of exactly the SVG
 * geometry and an e2e test pins that conversion to identical bytes, so the SVG proof
 * stands in for all of the engraving and only the conversion itself goes unseen.
 */
interface Rasteriser {
  label: string;
  /** How to test for it without running a conversion. */
  probe: [string, string[]];
  run: (pdf: string, outPath: string) => void;
}

const RASTERISERS: Rasteriser[] = [
  {
    label: 'pdftoppm (poppler-utils)',
    probe: ['command', ['-v', 'pdftoppm']],
    run: (pdf, out) => {
      const prefix = out.replace(/\.png$/, '');
      execFileSync('pdftoppm', ['-r', '150', '-png', '-f', '1', '-l', '1', pdf, prefix], {
        stdio: 'ignore',
      });
      // Poppler appends its own page number, so claim whatever it produced.
      adopt(`${prefix}-`, out);
    },
  },
  {
    label: 'mutool (mupdf-tools)',
    probe: ['command', ['-v', 'mutool']],
    run: (pdf, out) => {
      execFileSync('mutool', ['draw', '-r', '150', '-o', out, pdf, '1'], { stdio: 'ignore' });
    },
  },
  {
    label: 'pypdfium2 via uvx (no root needed)',
    probe: ['command', ['-v', 'uvx']],
    run: (pdf, out) => {
      const stem = 'pdfium-page';
      execFileSync(
        'uvx',
        [
          '--with', 'pillow',
          '--from', 'pypdfium2',
          'pypdfium2', 'render',
          '-o', PROOF_DIR,
          '--pages', '1',
          '--scale', '2',
          '--format', 'png',
          '--prefix', `${stem}-`,
          pdf,
        ],
        { stdio: 'ignore' },
      );
      adopt(resolve(PROOF_DIR, `${stem}-`), out);
    },
  },
];

/** Find the single file a tool wrote under `prefix*` and move it to `outPath`. */
function adopt(prefix: string, outPath: string): void {
  const directory = dirname(prefix);
  const stem = basename(prefix);
  const produced = readdirSync(directory).filter(
    (name) => name.startsWith(stem) && name.endsWith('.png'),
  );
  const first = produced[0];
  if (first === undefined) throw new Error(`the rasteriser wrote nothing matching ${prefix}*`);
  const from = resolve(directory, first);
  if (from !== outPath) renameSync(from, outPath);
}

function rasterisePdf(pdfPath: string, outPath: string): string | null {
  for (const rasteriser of RASTERISERS) {
    const [bin, args] = rasteriser.probe;
    try {
      execFileSync(bin, args, { stdio: 'ignore', shell: '/bin/sh' });
    } catch {
      continue;
    }
    try {
      rasteriser.run(pdfPath, outPath);
      return rasteriser.label;
    } catch {
      // Present but unusable — offline uvx, a broken build. Try the next one.
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Census: what the SVG contains, and how that differs from the snapshot
// ---------------------------------------------------------------------------

function census(svg: string): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (key: string, by = 1): void => {
    counts.set(key, (counts.get(key) ?? 0) + by);
  };

  for (const match of svg.matchAll(/class="(vf-[a-z]+)"/g)) bump(match[1] ?? '?');
  bump('<path>', (svg.match(/<path/g) ?? []).length);
  bump('<text>', (svg.match(/<text/g) ?? []).length);
  bump('<rect>', (svg.match(/<rect/g) ?? []).length);
  return counts;
}

/**
 * The census delta is what diagnosed the stray-flag bug: -15 stems and -15 flags over
 * exactly the fixture's 15 beamed notes said what had changed and why, where the raw
 * snapshot diff said only "one very long line differs".
 */
function reportCensus(fixture: string, svg: string): void {
  const now = census(svg);
  const snapshotPath = resolve(`tests/snapshots/${fixture}.page1.svg`);
  const before = existsSync(snapshotPath)
    ? census(readFileSync(snapshotPath, 'utf8'))
    : new Map<string, number>();
  const baseline = existsSync(snapshotPath);

  const keys = [...new Set([...before.keys(), ...now.keys()])].sort();
  const width = Math.max(...keys.map((k) => k.length));

  process.stdout.write(`\ncensus — ${fixture}\n`);
  process.stdout.write(
    `  ${'element'.padEnd(width)}  ${baseline ? 'snapshot   now  delta' : 'count'}\n`,
  );
  for (const key of keys) {
    const a = before.get(key) ?? 0;
    const b = now.get(key) ?? 0;
    if (!baseline) {
      process.stdout.write(`  ${key.padEnd(width)}  ${String(b).padStart(5)}\n`);
      continue;
    }
    const delta = b - a;
    const mark = delta === 0 ? '     .' : `  ${delta > 0 ? '+' : ''}${delta}`;
    process.stdout.write(
      `  ${key.padEnd(width)}  ${String(a).padStart(8)}  ${String(b).padStart(4)}${mark}\n`,
    );
  }
  if (baseline && keys.every((k) => (before.get(k) ?? 0) === (now.get(k) ?? 0))) {
    process.stdout.write('  structurally identical to the committed snapshot\n');
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

interface Options {
  fixtures: string[];
  paper: Paper;
  systems: number[];
  bars: number[];
  allSystems: boolean;
  census: boolean;
  pdf: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    fixtures: [],
    paper: 'a4',
    systems: [],
    bars: [],
    allSystems: false,
    census: false,
    pdf: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--system':
        options.systems.push(Number(argv[(i += 1)]));
        break;
      case '--bar':
        options.bars.push(Number(argv[(i += 1)]));
        break;
      case '--systems':
        options.allSystems = true;
        break;
      case '--census':
        options.census = true;
        break;
      case '--pdf':
        options.pdf = true;
        break;
      case '--paper':
        options.paper = argv[(i += 1)] as Paper;
        break;
      default:
        if (arg !== undefined && !arg.startsWith('--')) options.fixtures.push(arg);
    }
  }

  if (options.fixtures.length === 0) options.fixtures = Object.keys(FIXTURES);
  return options;
}

async function proof(fixture: string, options: Options): Promise<Manifest> {
  const build = FIXTURES[fixture];
  if (build === undefined) {
    throw new Error(`unknown fixture: ${fixture}\nknown: ${Object.keys(FIXTURES).join(', ')}`);
  }

  const score = build();
  const result = layout(score, { paper: options.paper });
  const pages = renderScoreToSvg(score, { paper: options.paper });
  const svg = pages[0]?.svg;
  if (svg === undefined) throw new Error('nothing rendered');

  mkdirSync(PROOF_DIR, { recursive: true });
  writeFileSync(resolve(PROOF_DIR, `${fixture}.page1.svg`), svg);

  const crops: Crop[] = [];
  if (options.allSystems) {
    const total = result.pages.flatMap((page) => page.systems).length;
    for (let i = 1; i <= total; i += 1) crops.push(systemCrop(result, i));
  }
  for (const index of options.systems) crops.push(systemCrop(result, index));
  for (const bar of options.bars) crops.push(barCrop(result, bar));
  if (crops.length === 0) {
    for (const page of result.pages) crops.push(wholePage(result, page.index));
  }

  const manifest: Manifest = { fixture, images: [] };
  for (const crop of crops) {
    const { png, zoom } = rasterise(svg, crop);
    const file = `${fixture}.${crop.name}.png`;
    writeFileSync(resolve(PROOF_DIR, file), png);
    manifest.images.push({ file: `out/proof/${file}`, shows: crop.what, zoom });
  }

  if (options.pdf) {
    const pdfPath = resolve(PROOF_DIR, `${fixture}.pdf`);
    writeFileSync(pdfPath, await renderScoreToPdf(score, { paper: options.paper }));
    const pngPath = resolve(PROOF_DIR, `${fixture}.pdf-page1.png`);
    const used = rasterisePdf(pdfPath, pngPath);
    if (used === null) {
      process.stdout.write(
        '\n  No PDF rasteriser found. Any one of these gives you --pdf:\n' +
          '    uv tool install --with pillow pypdfium2   (no root; PDFium, BSD/Apache)\n' +
          '    sudo apt install poppler-utils           (pdftoppm; GPL)\n' +
          '    sudo apt install mupdf-tools             (mutool; AGPL)\n' +
          '  Nothing is committed for this because ADR-0027 keeps the dependency\n' +
          '  register permissive, and a tool you look at output with is a separate\n' +
          '  program rather than part of the product.\n' +
          '  Meanwhile the SVG proof carries the same geometry, so only the SVG-to-PDF\n' +
          '  conversion goes unseen, and an e2e test pins that to identical bytes.\n',
      );
    } else {
      manifest.images.push({
        file: `out/proof/${fixture}.pdf-page1.png`,
        shows: `page 1 of the PDF itself, rasterised by ${used}`,
        zoom: 1,
      });
    }
  }

  if (options.census) reportCensus(fixture, svg);
  return manifest;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const manifests: Manifest[] = [];

  for (const fixture of options.fixtures) {
    manifests.push(await proof(fixture, options));
  }

  writeFileSync(
    resolve(PROOF_DIR, 'manifest.json'),
    `${JSON.stringify({ paper: options.paper, fixtures: manifests }, null, 2)}\n`,
  );

  process.stdout.write('\nproofs written — open or Read these:\n');
  for (const manifest of manifests) {
    for (const image of manifest.images) {
      process.stdout.write(`  ${image.file}\n      ${image.shows} (${image.zoom.toFixed(1)}x)\n`);
    }
  }
  process.stdout.write('\nmanifest: out/proof/manifest.json\n');
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
    process.exit(1);
  },
);
