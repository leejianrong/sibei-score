import { generateScore, makeRng } from '@sibei/synth';
import {
  degrade,
  degradationPreset,
  perspectiveWarp,
  renderScoreToPng,
} from '@sibei/synth/imaging';
import type { RawImage } from '@sibei/synth/imaging';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Degradation must be deterministic given a seed (ADR-0031: a seed in, the same corpus out) and it
 * must actually change the image, or the harness could not tell a clean corpus from a degraded one
 * (ADR-0020). Infra layer: sharp is a native binding.
 */

let clean: Buffer;

beforeAll(() => {
  clean = renderScoreToPng(generateScore({ seed: 10, bars: 4 }), { zoom: 1 })[0] as Buffer;
});

describe('degrade', () => {
  it('is byte-identical for the same input and seed', async () => {
    const opts = degradationPreset('medium');
    const a = await degrade(clean, opts, makeRng(7));
    const b = await degrade(clean, opts, makeRng(7));
    expect(a.format).toBe('jpeg');
    expect(a.data.equals(b.data)).toBe(true);
  });

  it('differs across seeds', async () => {
    const opts = degradationPreset('medium');
    const a = await degrade(clean, opts, makeRng(1));
    const b = await degrade(clean, opts, makeRng(2));
    expect(a.data.equals(b.data)).toBe(false);
  });

  it('leaves the clean preset lossless (PNG) and changes it under heavier presets', async () => {
    const asClean = await degrade(clean, degradationPreset('clean'), makeRng(0));
    expect(asClean.format).toBe('png');

    const degraded = await degrade(clean, degradationPreset('heavy'), makeRng(0));
    expect(degraded.format).toBe('jpeg');
    // The degraded image is a genuinely different picture, not just a re-encode of the same one.
    const cleanPixels = await sharp(clean).ensureAlpha().raw().toBuffer();
    const degradedPixels = await sharp(degraded.data).ensureAlpha().raw().toBuffer();
    expect(degradedPixels.equals(cleanPixels)).toBe(false);
  });

  it('keeps the page dimensions through degradation', async () => {
    const before = await sharp(clean).metadata();
    const after = await sharp((await degrade(clean, degradationPreset('medium'), makeRng(3))).data).metadata();
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
  });
});

describe('perspectiveWarp', () => {
  it('preserves dimensions, fills exposed area, and actually warps', () => {
    // A tiny synthetic 4x4 RGBA image: a black square on white.
    const width = 4;
    const height = 4;
    const data = Buffer.alloc(width * height * 4, 255);
    // paint the interior pixel (1,1) black
    const i = (1 * width + 1) * 4;
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
    const image: RawImage = { data, width, height, channels: 4 };

    const warped = perspectiveWarp(image, [
      [0.1, 0.1],
      [0.9, 0.0],
      [1.0, 1.0],
      [0.0, 0.9],
    ]);
    expect(warped.width).toBe(width);
    expect(warped.height).toBe(height);
    expect(warped.data.length).toBe(data.length);
    expect(warped.data.equals(data)).toBe(false);
    // Every output pixel is a real RGBA quad (alpha 255 everywhere — no transparent holes).
    for (let p = 3; p < warped.data.length; p += 4) expect(warped.data[p]).toBe(255);
  });

  it('is an identity map when the corners are the unit rectangle', () => {
    const width = 3;
    const height = 3;
    const data = Buffer.from(
      Array.from({ length: width * height * 4 }, (_v, k) => (k % 4 === 3 ? 255 : (k * 7) % 256)),
    );
    const image: RawImage = { data, width, height, channels: 4 };
    const warped = perspectiveWarp(image, [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    // The interior maps to itself; edges may sample the clamped border, so check the centre pixel.
    const c = (1 * width + 1) * 4;
    for (let ch = 0; ch < 3; ch += 1) expect(warped.data[c + ch]).toBe(data[c + ch]);
  });
});
