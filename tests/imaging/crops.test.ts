import { buildVocabulary, extractSystemLabels, generateScore } from '@sibei/synth';
import { renderSystemCrops } from '@sibei/synth/imaging';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

/**
 * The crop cutter turns each system's units-box into a pixel strip — the pixel half of the Stage-2a
 * training pairs (V15a, ADR-0031). Infra-layer: it loads `sharp`, forbidden in the fast layer. The
 * box geometry itself is proved by eye (`scripts/v15a-crops-proof.ts`, agent_docs/proofing.md); these
 * tests pin the mechanics — one valid PNG per system, carrying its label sequence, and determinism.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // \x89PNG

describe('renderSystemCrops', () => {
  it('cuts one valid PNG per system, each carrying its token sequence', async () => {
    const score = generateScore({ seed: 3, bars: 16 });
    const vocab = buildVocabulary();
    const crops = await renderSystemCrops(score, { zoom: 2, vocab });

    // 16 bars, four to a system.
    expect(crops).toHaveLength(4);
    expect(crops.map((c) => c.index)).toEqual([0, 1, 2, 3]);

    const labels = extractSystemLabels(score, { vocab });
    for (const crop of crops) {
      expect(crop.png.subarray(0, 4)).toEqual(PNG_MAGIC);
      const meta = await sharp(crop.png).metadata();
      expect(meta.width).toBe(crop.widthPx);
      expect(meta.height).toBe(crop.heightPx);
      expect(crop.widthPx).toBeGreaterThan(0);
      expect(crop.heightPx).toBeGreaterThan(0);
      // The crop's labels are exactly the pure extractor's, so training pairs match the ground truth.
      expect(crop.tokens).toEqual(labels[crop.index]!.tokens);
      expect(crop.tokenIds).toEqual(labels[crop.index]!.tokenIds);
    }
  });

  it('is deterministic for a seed', async () => {
    const a = await renderSystemCrops(generateScore({ seed: 5, bars: 12 }), { zoom: 2 });
    const b = await renderSystemCrops(generateScore({ seed: 5, bars: 12 }), { zoom: 2 });
    expect(a.map((c) => [c.widthPx, c.heightPx])).toEqual(b.map((c) => [c.widthPx, c.heightPx]));
    expect(Buffer.compare(a[0]!.png, b[0]!.png)).toBe(0);
  });

  it('omits tokenIds when no vocabulary is given', async () => {
    const crops = await renderSystemCrops(generateScore({ seed: 1, bars: 8 }), { zoom: 1 });
    expect(crops.every((c) => c.tokenIds === undefined)).toBe(true);
  });
});
