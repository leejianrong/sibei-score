/**
 * Dump a Stage-1 layout-detection corpus: many synthetic charts → full-page images and their
 * page-level object boxes (staff, barline, chordBand, title), on disk in a layout a detector's
 * DataLoader can read (V16, ADR-0031). This is what V16b's GPU training consumes, and it ships
 * BEFORE any model — the load-bearing piece, exactly as V15a did for Stage-2a.
 *
 *   pnpm tsx scripts/v16a-dump-detect-corpus.ts --seeds 200 --bars 24 --out out/v16a-corpus --levels clean,light,medium
 *
 * Output layout (under --out):
 *   classes.json        { classes: [...], count }            the shared class manifest (id = array index)
 *   labels.jsonl        one line per page image: { image, seed, page, level, width, height, boxes: [...] }
 *   pages/<name>.<ext>  the page images (png, or jpg for a degraded level that emits jpeg)
 *
 * **Degradation is photometric only here** (blur, shadow, texture, noise, JPEG — perspective forced
 * to 0). Those effects do not move pixels, so the boxes read off the clean layout stay aligned. The
 * geometric half (perspective/rotation) *does* move pixels, and moving the boxes with it is
 * on-the-fly, label-safe augmentation done in V16b training (rotate/warp image + boxes jointly) — the
 * same split V15 used for Stage-2a ("on-the-fly augmentation is label-safe only"). Deterministic in
 * the seed.
 *
 * A fraction of charts are given a title/composer so the `title` class has examples; a real import
 * has none (Q37), but the detector still has to recognise the header block when a printed chart shows
 * one, and the generator defaults to no header.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOX_CLASSES, generateScore, makeRng } from '@sibei/synth';
import type { DegradeLevel } from '@sibei/synth/imaging';
import { degradationPreset, degrade, renderDetectPages } from '@sibei/synth/imaging';

interface Args {
  seedStart: number;
  seedEnd: number; // exclusive
  bars: number;
  out: string;
  zoom: number;
  levels: DegradeLevel[];
  titledFrac: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const seeds = get('--seeds') ?? '50';
  let seedStart = 0;
  let seedEnd = 50;
  if (seeds.includes('-')) {
    const [a, b] = seeds.split('-').map(Number);
    seedStart = a ?? 0;
    seedEnd = (b ?? 0) + 1;
  } else {
    seedEnd = Number(seeds);
  }
  const levels = (get('--levels') ?? 'clean').split(',').map((s) => s.trim()) as DegradeLevel[];
  return {
    seedStart,
    seedEnd,
    bars: Number(get('--bars') ?? 24),
    out: get('--out') ?? join('out', 'v16a-corpus'),
    zoom: Number(get('--zoom') ?? 2),
    levels,
    titledFrac: Number(get('--titled-frac') ?? 0.5),
  };
}

const LEVEL_INDEX: Record<DegradeLevel, number> = { clean: 0, light: 1, medium: 2, heavy: 3 };

// A small deterministic word pool so a titled chart reads like a real head, not lorem ipsum.
const TITLE_WORDS = ['Blue', 'Green', 'Autumn', 'Round', 'Midnight', 'Stella', 'Moon', 'Bird', 'Bag', 'Night', 'Sunny', 'Bright', 'Now', 'Days', 'Dream', 'Waltz'];
const COMPOSERS = ['B. Evans', 'W. Shorter', 'T. Monk', 'M. Davis', 'J. Coltrane', 'D. Ellington', 'C. Corea', 'H. Hancock'];

function header(seed: number, titledFrac: number): { title: string; composer: string } {
  const rng = makeRng(seed * 7 + 1);
  if (rng.next() >= titledFrac) return { title: '', composer: '' };
  const n = rng.int(1, 3);
  const words: string[] = [];
  for (let i = 0; i < n; i += 1) words.push(TITLE_WORDS[rng.int(0, TITLE_WORDS.length - 1)]!);
  return { title: words.join(' '), composer: COMPOSERS[rng.int(0, COMPOSERS.length - 1)]! };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pagesDir = join(args.out, 'pages');
  mkdirSync(pagesDir, { recursive: true });

  writeFileSync(
    join(args.out, 'classes.json'),
    JSON.stringify({ classes: BOX_CLASSES, count: BOX_CLASSES.length }, null, 2),
  );

  const labelLines: string[] = [];
  let pageCount = 0;

  for (let seed = args.seedStart; seed < args.seedEnd; seed += 1) {
    const { title, composer } = header(seed, args.titledFrac);
    const score = generateScore({ seed, bars: args.bars, ...(title ? { title, composer } : {}) });
    const detected = await renderDetectPages(score, { zoom: args.zoom });

    for (const page of detected) {
      for (const level of args.levels) {
        let data = page.png;
        let ext = 'png';
        if (level !== 'clean') {
          // Photometric only — perspective disabled so the boxes stay aligned (see the header note).
          const rng = makeRng(seed * 100000 + page.page * 1000 + LEVEL_INDEX[level]);
          const result = await degrade(page.png, { ...degradationPreset(level), perspective: 0 }, rng);
          data = result.data;
          ext = result.format === 'jpeg' ? 'jpg' : 'png';
        }
        const name = `s${String(seed).padStart(5, '0')}_p${page.page}_${level}.${ext}`;
        writeFileSync(join(pagesDir, name), data);
        labelLines.push(
          JSON.stringify({
            image: join('pages', name),
            seed,
            page: page.page,
            level,
            width: page.widthPx,
            height: page.heightPx,
            boxes: page.boxes.map((b) => ({ cls: b.cls, clsId: b.clsId, system: b.system, x: b.x, y: b.y, w: b.width, h: b.height })),
          }),
        );
        pageCount += 1;
      }
    }
  }

  writeFileSync(join(args.out, 'labels.jsonl'), labelLines.join('\n') + '\n');

  const charts = args.seedEnd - args.seedStart;
  console.log(`wrote ${pageCount} page images from ${charts} charts (seeds ${args.seedStart}..${args.seedEnd - 1})`);
  console.log(`  levels:  ${args.levels.join(', ')}  (photometric only; geometric aug is on-the-fly in V16b)`);
  console.log(`  classes: ${BOX_CLASSES.join(', ')} -> ${join(args.out, 'classes.json')}`);
  console.log(`  labels:  ${join(args.out, 'labels.jsonl')}`);
  console.log(`  pages:   ${pagesDir}/`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
