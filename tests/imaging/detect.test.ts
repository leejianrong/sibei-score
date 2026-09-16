import { extractPageBoxes, generateScore } from '@sibei/synth';
import { renderDetectPages } from '@sibei/synth/imaging';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

/**
 * The detect renderer turns each page's units-boxes into pixel boxes on a rendered page — the pixel
 * half of the Stage-1 training pairs (V16, ADR-0031). Infra-layer: it loads `sharp`, forbidden in the
 * fast layer. The box geometry is proved by eye (`scripts/v16a-detect-proof.ts`, agent_docs/proofing.md);
 * these tests pin the mechanics — a valid PNG per page, one pixel box per unit box, all inside the
 * image, and determinism.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // \x89PNG

describe('renderDetectPages', () => {
  it('renders one page with pixel boxes matching the pure extractor, all inside the image', async () => {
    const score = generateScore({ seed: 3, bars: 24, title: 'Blue in Green', composer: 'B. Evans' });
    const pages = await renderDetectPages(score, { zoom: 2 });
    const unit = extractPageBoxes(score);

    expect(pages).toHaveLength(unit.length);
    for (const page of pages) {
      expect(page.png.subarray(0, 4)).toEqual(PNG_MAGIC);
      const meta = await sharp(page.png).metadata();
      expect(meta.width).toBe(page.widthPx);
      expect(meta.height).toBe(page.heightPx);
      // Same object count as the pure extractor (every unit box scales to a positive pixel box).
      expect(page.boxes.length).toBe(unit[page.page]!.objects.length);
      for (const b of page.boxes) {
        expect(b.width).toBeGreaterThan(0);
        expect(b.height).toBeGreaterThan(0);
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width).toBeLessThanOrEqual(page.widthPx);
        expect(b.y + b.height).toBeLessThanOrEqual(page.heightPx);
      }
    }
  });

  it('is deterministic for a seed', async () => {
    const a = await renderDetectPages(generateScore({ seed: 5, bars: 16 }), { zoom: 2 });
    const b = await renderDetectPages(generateScore({ seed: 5, bars: 16 }), { zoom: 2 });
    expect(a.map((p) => p.boxes)).toEqual(b.map((p) => p.boxes));
    expect(Buffer.compare(a[0]!.png, b[0]!.png)).toBe(0);
  });
});
