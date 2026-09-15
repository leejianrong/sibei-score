/**
 * Dump a Stage-2a training corpus: many synthetic charts → per-system crop images, their token-id
 * sequences, and the vocabulary manifest, on disk in a layout a PyTorch DataLoader can read (V15a,
 * ADR-0031). This is what V15b's GPU training consumes.
 *
 *   pnpm tsx scripts/v15a-dump-corpus.ts --seeds 200 --bars 16 --out out/v15a-corpus --levels clean,light,medium
 *
 * Output layout (under --out):
 *   vocab.json          { size, blank: 0, symbols: [...] }   the shared manifest (id = array index)
 *   labels.jsonl        one line per crop: { image, seed, system, level, tokenIds, tokens, width, height }
 *   crops/<id>.<ext>    the crop images (png, or jpg for a degraded level that emits jpeg)
 *
 * Degradation is applied per-crop, AFTER cropping, so the labels stay aligned: a perspective warp
 * moves pixels, which would break a box computed from the clean layout if we degraded the page first.
 * The token sequence is unchanged by degradation (same notes, same order), so a degraded crop reuses
 * its clean crop's labels. `clean` writes the crop as-is. Deterministic in the seed.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildVocabulary, generateScore, makeRng, tokenSymbol } from '@sibei/synth';
import type { DegradeLevel } from '@sibei/synth/imaging';
import { degrade, degradationPreset, renderSystemCrops } from '@sibei/synth/imaging';

interface Args {
  seedStart: number;
  seedEnd: number; // exclusive
  bars: number;
  out: string;
  zoom: number;
  levels: DegradeLevel[];
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
    bars: Number(get('--bars') ?? 16),
    out: get('--out') ?? join('out', 'v15a-corpus'),
    zoom: Number(get('--zoom') ?? 2),
    levels,
  };
}

const LEVEL_INDEX: Record<DegradeLevel, number> = { clean: 0, light: 1, medium: 2, heavy: 3 };

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cropsDir = join(args.out, 'crops');
  mkdirSync(cropsDir, { recursive: true });

  const vocab = buildVocabulary();
  writeFileSync(
    join(args.out, 'vocab.json'),
    JSON.stringify({ size: vocab.size, blank: 0, symbols: vocab.symbols }, null, 2),
  );

  const labelLines: string[] = [];
  let cropCount = 0;

  for (let seed = args.seedStart; seed < args.seedEnd; seed += 1) {
    const score = generateScore({ seed, bars: args.bars });
    const crops = await renderSystemCrops(score, { zoom: args.zoom, vocab });

    for (const crop of crops) {
      for (const level of args.levels) {
        let data = crop.png;
        let ext = 'png';
        if (level !== 'clean') {
          // A per-(seed, system, level) rng, so degradation is varied but reproducible.
          const rng = makeRng(seed * 100000 + crop.index * 10 + LEVEL_INDEX[level]);
          const result = await degrade(crop.png, degradationPreset(level), rng);
          data = result.data;
          ext = result.format === 'jpeg' ? 'jpg' : 'png';
        }
        const name = `s${String(seed).padStart(5, '0')}_sys${crop.index}_${level}.${ext}`;
        writeFileSync(join(cropsDir, name), data);
        labelLines.push(
          JSON.stringify({
            image: join('crops', name),
            seed,
            system: crop.index,
            level,
            tokenIds: crop.tokenIds,
            tokens: crop.tokens.map(tokenSymbol),
            width: crop.widthPx,
            height: crop.heightPx,
          }),
        );
        cropCount += 1;
      }
    }
  }

  writeFileSync(join(args.out, 'labels.jsonl'), labelLines.join('\n') + '\n');

  const charts = args.seedEnd - args.seedStart;
  console.log(`wrote ${cropCount} crops from ${charts} charts (seeds ${args.seedStart}..${args.seedEnd - 1})`);
  console.log(`  levels:  ${args.levels.join(', ')}`);
  console.log(`  vocab:   ${vocab.size} classes -> ${join(args.out, 'vocab.json')}`);
  console.log(`  labels:  ${join(args.out, 'labels.jsonl')}`);
  console.log(`  crops:   ${cropsDir}/`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
