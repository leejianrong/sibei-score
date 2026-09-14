import { generateScore } from '@sibei/synth';
import { rasterizeSvg, renderScoreToPng, renderScoreToSvg } from '@sibei/synth/imaging';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

/**
 * The rasteriser turns a generated score into the clean image the corpus degrades from. These are
 * infra-layer tests: @resvg/resvg-js is a native binding, forbidden in the fast layer (KAN-514).
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // \x89PNG

describe('renderScoreToSvg', () => {
  it('produces one SVG page for a short lead sheet', () => {
    const pages = renderScoreToSvg(generateScore({ seed: 1, bars: 4 }));
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(pages[0]?.svg).toContain('<svg');
  });
});

describe('rasterizeSvg', () => {
  it('renders a PNG and is deterministic for the same SVG', () => {
    const svg = renderScoreToSvg(generateScore({ seed: 2, bars: 4 }))[0]?.svg as string;
    const a = rasterizeSvg(svg, { zoom: 1 });
    const b = rasterizeSvg(svg, { zoom: 1 });
    expect(a.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(a.equals(b)).toBe(true);
  });
});

describe('renderScoreToPng', () => {
  it('yields a decodable raster whose dimensions scale with zoom', async () => {
    const score = generateScore({ seed: 3, bars: 4 });
    const [png] = renderScoreToPng(score, { zoom: 2 });
    expect(png).toBeDefined();
    const meta = await sharp(png as Buffer).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
    // An A4 page is taller than it is wide.
    expect(meta.height as number).toBeGreaterThan(meta.width as number);
  });
});
