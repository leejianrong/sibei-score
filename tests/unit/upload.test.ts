import { describe, expect, it } from 'vitest';
import {
  MAX_UPLOAD_BYTES,
  imageFormatOf,
  multipartBoundary,
  parseMultipartImages,
  validateUpload,
} from '@sibei/api';

/**
 * The upload boundary (V10, ADR-0029): validate by **decoding**, real byte and dimension caps, the
 * format from content and never from a declared type. The V10 test plan's Unit clause names exactly
 * these cases: oversized, zero-byte, wrong-format, and dimension-bomb inputs.
 *
 * The fixtures are hand-built headers — the few bytes `validateUpload` actually reads — because that
 * is all the boundary looks at (it never decompresses pixels, which is what defeats a dimension
 * bomb), and because committing a real photo is forbidden (ADR-0020, copyright).
 */

/** A PNG that declares `width`×`height` in its IHDR. Enough bytes for the fixed-offset reader. */
function png(width: number, height: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25); // length(4) + 'IHDR'(4) + w(4) + h(4) + bitDepth/colour/etc(5).
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([header, ihdr]);
}

/** A JPEG whose first frame (SOF0) declares `width`×`height`. */
function jpeg(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(13);
  buffer.writeUInt16BE(0xffd8, 0); // SOI
  buffer.writeUInt16BE(0xffc0, 2); // SOF0
  buffer.writeUInt16BE(0x0011, 4); // segment length
  buffer.writeUInt8(8, 6); // sample precision
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

describe('validateUpload (ADR-0029)', () => {
  it('accepts a well-formed PNG and reports its format and dimensions', () => {
    const result = validateUpload(png(1612, 2280));
    expect(result).toEqual({ ok: true, format: 'png', width: 1612, height: 2280, contentType: 'image/png' });
  });

  it('accepts a well-formed JPEG and detects it from content, not a declared type', () => {
    const result = validateUpload(jpeg(1024, 768));
    expect(result).toEqual({ ok: true, format: 'jpeg', width: 1024, height: 768, contentType: 'image/jpeg' });
  });

  it('rejects a zero-byte upload', () => {
    const result = validateUpload(Buffer.alloc(0));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty');
  });

  it('rejects a wrong-format upload (not a PNG or JPEG)', () => {
    const result = validateUpload(Buffer.from('%PDF-1.7\nnot an image', 'ascii'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported-format');
  });

  it('rejects bytes that claim a format but have an unreadable header', () => {
    // A PNG signature followed by no IHDR — declares itself PNG, decodes to nothing.
    const truncated = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const result = validateUpload(truncated);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('undecodable');
  });

  it('rejects a dimension bomb — a tiny file declaring an enormous image', () => {
    // 100000×100000 is 10 billion pixels in a 33-byte file. The classic memory-exhaustion header.
    const bomb = png(100_000, 100_000);
    expect(bomb.length).toBeLessThan(100);
    const result = validateUpload(bomb);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('dimensions-too-large');
  });

  it('rejects a lopsided dimension bomb under the pixel cap but over the per-side cap', () => {
    const strip = png(200_000, 2);
    const result = validateUpload(strip);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('dimensions-too-large');
  });

  it('rejects an oversized upload', () => {
    // A buffer past the byte cap. Its header is a valid PNG, so only the size is wrong.
    const big = Buffer.concat([png(10, 10), Buffer.alloc(MAX_UPLOAD_BYTES + 1)]);
    const result = validateUpload(big);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too-large');
  });

  it('rejects a non-positive dimension', () => {
    const result = validateUpload(png(0, 100));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('undecodable');
  });

  it('honours injected caps', () => {
    const tight = validateUpload(png(5000, 5000), { maxDimension: 4000 });
    expect(tight.ok).toBe(false);
    if (!tight.ok) expect(tight.reason).toBe('dimensions-too-large');
  });
});

describe('imageFormatOf', () => {
  it('names the format of real image bytes and null for anything else', () => {
    expect(imageFormatOf(png(10, 10))).toBe('png');
    expect(imageFormatOf(jpeg(10, 10))).toBe('jpeg');
    expect(imageFormatOf(Buffer.from('nope'))).toBeNull();
    expect(imageFormatOf(Buffer.alloc(0))).toBeNull();
  });
});

describe('multipart (several pages in one upload, Q26)', () => {
  it('reads the boundary token, and null for a non-multipart type', () => {
    expect(multipartBoundary('multipart/form-data; boundary=abc123')).toBe('abc123');
    expect(multipartBoundary('multipart/form-data; boundary="quoted"')).toBe('quoted');
    expect(multipartBoundary('image/png')).toBeNull();
    expect(multipartBoundary(undefined)).toBeNull();
  });

  /** Assemble a minimal multipart/form-data body from a list of `[name, filename|null, bytes]` parts. */
  function multipart(boundary: string, parts: Array<[string, string | null, Buffer]>): Buffer {
    const chunks: Buffer[] = [];
    for (const [name, filename, body] of parts) {
      const disposition =
        filename === null
          ? `form-data; name="${name}"`
          : `form-data; name="${name}"; filename="${filename}"`;
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n\r\n`));
      chunks.push(body);
      chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return Buffer.concat(chunks);
  }

  it('extracts each file part in order, keeping the raw bytes intact', () => {
    const a = png(100, 100);
    const b = jpeg(200, 200);
    const body = multipart('X', [
      ['images', 'a.png', a],
      ['images', 'b.jpg', b],
    ]);
    const images = parseMultipartImages(body, 'X');
    expect(images).toHaveLength(2);
    expect(images[0]!.equals(a)).toBe(true);
    expect(images[1]!.equals(b)).toBe(true);
  });

  it('ignores non-file form fields (no filename)', () => {
    const a = png(100, 100);
    const body = multipart('X', [
      ['title', null, Buffer.from('Blue Bossa')],
      ['images', 'a.png', a],
    ]);
    const images = parseMultipartImages(body, 'X');
    expect(images).toHaveLength(1);
    expect(images[0]!.equals(a)).toBe(true);
  });

  it('returns an empty list for a body without the boundary', () => {
    expect(parseMultipartImages(Buffer.from('not multipart at all'), 'X')).toEqual([]);
  });
});
