/**
 * Dump a Stage-2b chord-band training corpus: many synthetic charts → per-system chord-band crop
 * images, their character-id target sequences, and the vocabulary manifest, laid out for a PyTorch
 * DataLoader (V17b, ADR-0031). This is what V17c's GPU training consumes.
 *
 *   pnpm dump:v17b --seeds 300 --bars 16 --out out/v17b-corpus --levels clean,light,medium
 *
 * Output layout (under --out):
 *   vocab.json          { size, blank: 0, sep: 1, symbols: [...] }   the shared manifest (id = index)
 *   labels.jsonl        one line per crop: { image, seed, system, level, chords, tokenIds, width, height }
 *   crops/<id>.<ext>    the band crop images (png, or jpg for a degraded level that emits jpeg)
 *
 * Each chart is drawn in a per-seed random render style (V17a: music face, typeface, chord symbology),
 * so the recogniser sees typographic variety; the chord content is rich (V17b-i). The label is the
 * chord glyph strings the chosen style actually draws — `chordGlyphText` reads them back from the same
 * code that inks the pixels, so the CTC target and the image cannot drift. Degradation is applied
 * per-crop after cropping (labels are unchanged by it), exactly as the V15a dump does. Deterministic
 * in the seed.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildChordVocabulary, generateScore, makeRng, randomRenderStyle } from '@sibei/synth';
import type { DegradeLevel } from '@sibei/synth/imaging';
import { degrade, degradationPreset, renderBandCrops } from '@sibei/synth/imaging';

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
    out: get('--out') ?? join('out', 'v17b-corpus'),
    zoom: Number(get('--zoom') ?? 2),
    levels,
  };
}

const LEVEL_INDEX: Record<DegradeLevel, number> = { clean: 0, light: 1, medium: 2, heavy: 3 };

/** A render style stream salted off the seed, independent of both the note and the chord streams. */
const STYLE_SALT = 0x51ac_7b17;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cropsDir = join(args.out, 'crops');
  mkdirSync(cropsDir, { recursive: true });

  const vocab = buildChordVocabulary();
  writeFileSync(
    join(args.out, 'vocab.json'),
    JSON.stringify({ size: vocab.size, blank: vocab.blank, sep: vocab.sep, symbols: vocab.symbols }, null, 2),
  );

  const labelLines: string[] = [];
  let cropCount = 0;

  for (let seed = args.seedStart; seed < args.seedEnd; seed += 1) {
    const score = generateScore({ seed, bars: args.bars });
    const style = randomRenderStyle(makeRng((seed ^ STYLE_SALT) >>> 0));
    const crops = await renderBandCrops(score, {
      zoom: args.zoom,
      vocab,
      font: style.font,
      chordStyle: style.chordStyle,
      textFont: style.textFont,
    });

    for (const crop of crops) {
      if (crop.chords.length === 0) continue; // a band crop with no chords is nothing to learn from.
      for (const level of args.levels) {
        let data = crop.png;
        let ext = 'png';
        if (level !== 'clean') {
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
            chords: crop.chords,
            tokenIds: crop.tokenIds,
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
  console.log(`wrote ${cropCount} band crops from ${charts} charts (seeds ${args.seedStart}..${args.seedEnd - 1})`);
  console.log(`  levels:  ${args.levels.join(', ')}`);
  console.log(`  vocab:   ${vocab.size} classes -> ${join(args.out, 'vocab.json')}`);
  console.log(`  labels:  ${join(args.out, 'labels.jsonl')}`);
  console.log(`  crops:   ${cropsDir}/`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
