/**
 * A perspective (keystone) warp over a raw RGBA buffer.
 *
 * sharp can rotate, shear and scale (an affine map) but cannot do a true perspective
 * transform, and perspective is exactly what separates a *photo* of a page from a *scan* of
 * one — the near edge wider than the far edge (ADR-0020's corpus must look like real photos,
 * not clean renders). So this is done by hand: a 4-point homography from the source rectangle
 * to a slightly-jittered output quad, inverted, and bilinearly sampled.
 *
 * Framework-free apart from `Buffer` (a Node API — the ADR-0031 exception this package holds).
 */

/** A 3x3 homography, row-major, 9 numbers. */
type Matrix3 = number[];

/** Solve an 8x8 linear system by Gaussian elimination with partial pivoting. */
function solve8(a: number[][], b: number[]): number[] {
  const n = 8;
  // Augment.
  const m = a.map((row, i) => [...row, b[i] as number]);
  for (let col = 0; col < n; col += 1) {
    // Pivot: the row with the largest magnitude in this column.
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs((m[row] as number[])[col] as number) > Math.abs((m[pivot] as number[])[col] as number)) {
        pivot = row;
      }
    }
    const tmp = m[col] as number[];
    m[col] = m[pivot] as number[];
    m[pivot] = tmp;

    const pivotRow = m[col] as number[];
    const pivotVal = pivotRow[col] as number;
    if (pivotVal === 0) throw new Error('perspective: singular system');
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = ((m[row] as number[])[col] as number) / pivotVal;
      if (factor === 0) continue;
      for (let k = col; k <= n; k += 1) {
        (m[row] as number[])[k] = ((m[row] as number[])[k] as number) - factor * (pivotRow[k] as number);
      }
    }
  }
  const x = new Array<number>(n);
  for (let i = 0; i < n; i += 1) x[i] = ((m[i] as number[])[n] as number) / ((m[i] as number[])[i] as number);
  return x;
}

/**
 * The homography mapping the four source points to the four destination points, in order
 * (top-left, top-right, bottom-right, bottom-left). `h33` is fixed to 1.
 */
function homography(src: [number, number][], dst: [number, number][]): Matrix3 {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const [x, y] = src[i] as [number, number];
    const [u, v] = dst[i] as [number, number];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve8(a, b);
  return [h[0] as number, h[1] as number, h[2] as number, h[3] as number, h[4] as number, h[5] as number, h[6] as number, h[7] as number, 1];
}

function invert3(m: Matrix3): Matrix3 {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (det === 0) throw new Error('perspective: non-invertible homography');
  const inv = 1 / det;
  return [
    (e * i - f * h) * inv,
    (c * h - b * i) * inv,
    (b * f - c * e) * inv,
    (f * g - d * i) * inv,
    (a * i - c * g) * inv,
    (c * d - a * f) * inv,
    (d * h - e * g) * inv,
    (b * g - a * h) * inv,
    (a * e - b * d) * inv,
  ];
}

export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  /** Channels; expected 4 (RGBA) — the raw form sharp gives with `ensureAlpha`. */
  channels: number;
}

/**
 * Warp `image` so its corners land at the given output positions (fractions of width/height,
 * e.g. `[[0.02,0.01],[0.98,0.03],[0.97,0.99],[0.01,0.98]]`). Areas the page no longer covers
 * are filled with `background` (white paper by default). Output keeps the input's dimensions.
 */
export function perspectiveWarp(
  image: RawImage,
  cornerOffsets: [number, number][],
  background: [number, number, number] = [255, 255, 255],
): RawImage {
  const { data, width, height, channels } = image;
  if (channels !== 4) throw new Error(`perspectiveWarp expects RGBA, got ${channels} channels`);

  const src: [number, number][] = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ];
  const dst: [number, number][] = cornerOffsets.map(([fx, fy]) => [fx * width, fy * height]);
  // Map output coordinates back to source coordinates: invert the source->output homography.
  const inverse = invert3(homography(src, dst));

  const out = Buffer.alloc(data.length);
  const [br, bg, bb] = background;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const denom = (inverse[6] as number) * x + (inverse[7] as number) * y + (inverse[8] as number);
      const sx = ((inverse[0] as number) * x + (inverse[1] as number) * y + (inverse[2] as number)) / denom;
      const sy = ((inverse[3] as number) * x + (inverse[4] as number) * y + (inverse[5] as number)) / denom;
      const outIndex = (y * width + x) * 4;

      if (sx < 0 || sy < 0 || sx >= width - 1 || sy >= height - 1) {
        out[outIndex] = br as number;
        out[outIndex + 1] = bg as number;
        out[outIndex + 2] = bb as number;
        out[outIndex + 3] = 255;
        continue;
      }

      // Bilinear sample.
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      for (let ch = 0; ch < 4; ch += 1) {
        const i00 = (y0 * width + x0) * 4 + ch;
        const i10 = i00 + 4;
        const i01 = i00 + width * 4;
        const i11 = i01 + 4;
        const top = (data[i00] as number) * (1 - fx) + (data[i10] as number) * fx;
        const bottom = (data[i01] as number) * (1 - fx) + (data[i11] as number) * fx;
        out[outIndex + ch] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return { data: out, width, height, channels: 4 };
}
