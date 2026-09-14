/**
 * Seeded, deterministic image degradation: turn a clean render into something that looks
 * photographed. This is what closes the synthetic→real gap (ADR-0020, ADR-0031) and what makes
 * the harness *sensitive* — a degraded corpus must score measurably worse than a clean one, or the
 * harness is not measuring what it claims to.
 *
 * A photo pipeline, in order: geometry (perspective/tilt), lens blur, then sensor effects
 * (shadow, paper texture, noise) and finally JPEG compression — the order a real camera applies
 * them, so the artifacts compound the way real ones do. Every parameter is drawn from the seeded
 * `Rng`, so a seed reproduces the corpus byte for byte.
 *
 * Uses `sharp` and `Buffer` — native + Node, the ADR-0031 exception; hence the `imaging` subpath.
 */

import sharp from 'sharp';
import type { Rng } from '../rng.js';
import type { RawImage } from './perspective.js';
import { perspectiveWarp } from './perspective.js';

export type DegradeLevel = 'clean' | 'light' | 'medium' | 'heavy';

export interface DegradeOptions {
  /** Max corner displacement as a fraction of the dimension (0 = a flat scan). Covers tilt too. */
  perspective: number;
  /** Gaussian blur sigma (0 = sharp focus). */
  blur: number;
  /** Max darkening from an uneven-lighting gradient, 0..1. */
  shadow: number;
  /** Multiplicative paper-speckle amplitude, 0..1. */
  texture: number;
  /** Additive sensor-noise sigma, in 0..255. */
  noise: number;
  /** JPEG quality 1..100 for compression artifacts, or null for a lossless PNG (the clean case). */
  jpegQuality: number | null;
}

export interface DegradeResult {
  data: Buffer;
  format: 'png' | 'jpeg';
}

const PRESETS: Record<DegradeLevel, DegradeOptions> = {
  clean: { perspective: 0, blur: 0, shadow: 0, texture: 0, noise: 0, jpegQuality: null },
  light: { perspective: 0.006, blur: 0.4, shadow: 0.1, texture: 0.02, noise: 3, jpegQuality: 90 },
  medium: { perspective: 0.015, blur: 0.9, shadow: 0.22, texture: 0.05, noise: 7, jpegQuality: 72 },
  heavy: { perspective: 0.03, blur: 1.5, shadow: 0.38, texture: 0.09, noise: 14, jpegQuality: 52 },
};

export function degradationPreset(level: DegradeLevel): DegradeOptions {
  return { ...PRESETS[level] };
}

/** A standard normal sample (Box–Muller), driven by the seeded rng for reproducibility. */
function gaussian(rng: Rng): number {
  const u1 = Math.max(rng.next(), 1e-9);
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clamp8(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

/** Shadow gradient + paper speckle + sensor noise, applied per pixel to an RGBA buffer in place. */
function applyPhotometric(raw: RawImage, opts: DegradeOptions, rng: Rng): void {
  const { data, width, height } = raw;
  // A random lighting direction so shadows do not always fall the same way.
  const angle = rng.float(0, Math.PI * 2);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = ((x / width) * dx + (y / height) * dy + 1) / 2; // ~0..1 across the gradient
      const shadow = 1 - opts.shadow * t;
      const texture = 1 + opts.texture * (rng.next() - 0.5) * 2;
      const factor = shadow * texture;
      const i = (y * width + x) * 4;
      for (let ch = 0; ch < 3; ch += 1) {
        data[i + ch] = clamp8((data[i + ch] as number) * factor + gaussian(rng) * opts.noise);
      }
      // Alpha (i+3) is left alone.
    }
  }
}

/** A sharp pipeline instance. Named via ReturnType to avoid the `sharp.Sharp` namespace, which
 * `export =` plus verbatimModuleSyntax does not expose through the default import binding. */
type SharpImage = ReturnType<typeof sharp>;

async function toRaw(image: SharpImage): Promise<RawImage> {
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function fromRaw(raw: RawImage): SharpImage {
  return sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } });
}

/**
 * Degrade a PNG (or any sharp-readable image) into a photographed-looking one. Deterministic given
 * the same input and the same `rng` state.
 */
export async function degrade(input: Buffer, opts: DegradeOptions, rng: Rng): Promise<DegradeResult> {
  // 1. Geometry, on the clean high-res image.
  let raw = await toRaw(sharp(input));
  if (opts.perspective > 0) {
    const j = opts.perspective;
    const corners: [number, number][] = [
      [rng.float(0, j), rng.float(0, j)],
      [1 - rng.float(0, j), rng.float(0, j)],
      [1 - rng.float(0, j), 1 - rng.float(0, j)],
      [rng.float(0, j), 1 - rng.float(0, j)],
    ];
    raw = perspectiveWarp(raw, corners);
  }

  // 2. Lens blur (before sensor effects, so noise is not itself blurred).
  let pipeline = fromRaw(raw);
  if (opts.blur > 0) pipeline = pipeline.blur(opts.blur);

  // 3. Sensor effects: shadow, texture, noise.
  if (opts.shadow > 0 || opts.texture > 0 || opts.noise > 0) {
    raw = await toRaw(pipeline);
    applyPhotometric(raw, opts, rng);
    pipeline = fromRaw(raw);
  }

  // 4. Encode — JPEG for real compression artifacts, or PNG for the lossless clean case.
  if (opts.jpegQuality !== null) {
    const data = await pipeline.jpeg({ quality: opts.jpegQuality }).toBuffer();
    return { data, format: 'jpeg' };
  }
  const data = await pipeline.png().toBuffer();
  return { data, format: 'png' };
}
