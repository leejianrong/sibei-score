/**
 * Proof the V16 Stage-1 detection labels: render a synthetic chart and overlay its object boxes
 * (staff, barline, chordBand, title) on the page, so a person — and an agent reading the PNG — can
 * confirm the ground truth lands on real ink before training a detector on it.
 *
 * A box a few units off never fails a test but ruins the training data, so we eyeball it
 * (agent_docs/proofing.md).
 *
 *   pnpm tsx scripts/v16a-detect-proof.ts [seed] [bars]
 *
 * Writes to out/v16a/ (gitignored).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateScore } from '@sibei/synth';
import { renderDetectPages, renderPageBoxOverlay } from '@sibei/synth/imaging';

const seed = Number(process.argv[2] ?? 3);
const bars = Number(process.argv[3] ?? 24);
const outDir = join('out', 'v16a');
mkdirSync(outDir, { recursive: true });

async function main(): Promise<void> {
  const score = generateScore({ seed, bars, title: 'Blue in Green', composer: 'B. Evans' });

  const overlays = await renderPageBoxOverlay(score, { zoom: 2 });
  overlays.forEach((buf, i) => {
    const path = join(outDir, `overlay-p${i}.png`);
    writeFileSync(path, buf);
    console.log(`wrote ${path}`);
  });

  const pages = await renderDetectPages(score, { zoom: 2 });
  for (const page of pages) {
    const counts = page.boxes.reduce<Record<string, number>>((acc, b) => {
      acc[b.cls] = (acc[b.cls] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`page ${page.page} (${page.widthPx}x${page.heightPx}px): ${JSON.stringify(counts)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
