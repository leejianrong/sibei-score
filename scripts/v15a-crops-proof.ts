/**
 * Proof the V15a Stage-2a training crops: render a synthetic chart, cut its per-system crops, and
 * write images a person (and an agent reading the PNGs) can actually look at — an overlay of the
 * crop boxes on the page, each crop on its own, a stacked contact sheet, and the token sequences.
 *
 * Engraving-adjacent output is only trustworthy once someone has looked (agent_docs/proofing.md); a
 * crop box that is a few units off never fails a test but ruins the training data, so we eyeball it.
 *
 *   pnpm tsx scripts/v15a-crops-proof.ts [seed] [bars]
 *
 * Writes to out/v15a/ (gitignored).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildVocabulary, generateScore, tokenSymbol } from '@sibei/synth';
import { renderSystemBoxOverlay, renderSystemCrops } from '@sibei/synth/imaging';
import sharp from 'sharp';

const seed = Number(process.argv[2] ?? 3);
const bars = Number(process.argv[3] ?? 16);
const outDir = join('out', 'v15a');
mkdirSync(outDir, { recursive: true });

async function stack(crops: { png: Buffer; widthPx: number; heightPx: number }[]): Promise<Buffer> {
  // A contact sheet: every crop on one canvas, top to bottom, so one glance shows them all.
  const gap = 16;
  const width = Math.max(...crops.map((c) => c.widthPx));
  const height = crops.reduce((sum, c) => sum + c.heightPx + gap, gap);
  const composites = [];
  let top = gap;
  for (const crop of crops) {
    composites.push({ input: crop.png, top, left: 0 });
    top += crop.heightPx + gap;
  }
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite(composites)
    .png()
    .toBuffer();
}

async function main(): Promise<void> {
  const score = generateScore({ seed, bars });
  const vocab = buildVocabulary();

  const overlays = await renderSystemBoxOverlay(score, { zoom: 2 });
  overlays.forEach((buf, i) => {
    const path = join(outDir, `overlay-p${i}.png`);
    writeFileSync(path, buf);
    console.log(`wrote ${path}`);
  });

  const crops = await renderSystemCrops(score, { zoom: 2, vocab });
  for (const crop of crops) {
    const path = join(outDir, `crop-sys${crop.index}.png`);
    writeFileSync(path, crop.png);
  }
  console.log(`wrote ${crops.length} crops to ${outDir}/crop-sys*.png`);

  const sheet = await stack(crops);
  const sheetPath = join(outDir, 'contact-sheet.png');
  writeFileSync(sheetPath, sheet);
  console.log(`wrote ${sheetPath}`);

  const lines = crops.map((crop) => ({
    system: crop.index,
    tokens: crop.tokens.map(tokenSymbol),
    tokenIds: crop.tokenIds,
  }));
  writeFileSync(join(outDir, 'labels.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  console.log(`\nvocabulary: ${vocab.size} classes (seed ${seed}, ${bars} bars)\n`);
  for (const crop of crops) {
    console.log(`sys ${crop.index} (${crop.widthPx}x${crop.heightPx}px): ${crop.tokens.map(tokenSymbol).join(' ')}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
