/**
 * The upload boundary: the one place untrusted bytes enter the app (ADR-0029).
 *
 * ADR-0029 is explicit that an upload is validated by **decoding** it — real dimension and byte
 * caps, the format detected from the content — rather than by trusting a declared content type or a
 * file extension. This module is that decode. It reads just enough of a PNG or JPEG header to prove
 * the bytes are that format and to learn the pixel dimensions, so a malformed or hostile image is
 * refused here rather than three layers deep inside oemer (ADR-0018 restricts import to printed
 * raster images; PNG and JPEG are the two that a scan or a phone photo actually arrives as).
 *
 * It reads the header only — it never decompresses the pixels — which is exactly what defeats a
 * *dimension bomb*: a tiny file whose header declares an enormous width × height to make a decoder
 * allocate gigabytes. The declared dimensions are checked against a cap **before** anything hands
 * the file to a decoder, so the cap costs a few bytes of parsing, not the allocation it prevents.
 *
 * Pure, Node-free of anything but `Buffer`, and with no image-decoding dependency: a hand-rolled
 * header reader is a hundred lines and matches this codebase's habit of owning its boundaries (the
 * codec's own XML reader, the engraver's own metrics) rather than pulling a native image library
 * into the one package ADR-0006 keeps deliberately thin.
 */

/** The raster formats import accepts (ADR-0018). */
export type ImageFormat = 'png' | 'jpeg';

/** Why an upload was refused. Each maps to a status the route sends (see `import-routes.ts`). */
export type UploadRejection =
  | 'empty'
  | 'too-large'
  | 'unsupported-format'
  | 'undecodable'
  | 'dimensions-too-large';

export interface UploadOk {
  ok: true;
  format: ImageFormat;
  width: number;
  height: number;
  /** The media type to hand the worker, derived from the content, never from the request. */
  contentType: string;
}

export interface UploadRefused {
  ok: false;
  reason: UploadRejection;
  message: string;
}

export type UploadResult = UploadOk | UploadRefused;

export interface UploadCaps {
  /** Reject a file larger than this many bytes. Defaults to {@link MAX_UPLOAD_BYTES}. */
  maxBytes?: number;
  /** Reject either dimension larger than this. Defaults to {@link MAX_IMAGE_DIMENSION}. */
  maxDimension?: number;
  /** Reject a total pixel count larger than this. Defaults to {@link MAX_IMAGE_PIXELS}. */
  maxPixels?: number;
}

/**
 * 25 MB. A phone photo of a lead sheet is a few megabytes; a high-resolution flatbed scan is the
 * upper end this allows. oemer normalises every input to ~3.67 MP before recognising (ADR-0025), so
 * anything past this is bytes the pipeline throws away — the cap protects the upload path, not the
 * recogniser.
 */
export const MAX_UPLOAD_BYTES = 25_000_000;

/**
 * 20000 px per side and 100 MP total. Comfortably above any real page scan, and far below the
 * dimensions a decompression bomb declares to exhaust memory. Two caps because either can be the
 * attack: a 100000×2 strip is under the pixel cap but absurd, and a 15000×15000 square is under the
 * per-side cap but 225 MP.
 */
export const MAX_IMAGE_DIMENSION = 20_000;
export const MAX_IMAGE_PIXELS = 100_000_000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Validate uploaded bytes as an importable image, returning its format and dimensions or the reason
 * it was refused. Total: it reports the first fatal problem it finds and never throws on bad input —
 * bad input is the expected case at a boundary.
 */
export function validateUpload(bytes: Buffer, caps: UploadCaps = {}): UploadResult {
  const maxBytes = caps.maxBytes ?? MAX_UPLOAD_BYTES;
  const maxDimension = caps.maxDimension ?? MAX_IMAGE_DIMENSION;
  const maxPixels = caps.maxPixels ?? MAX_IMAGE_PIXELS;

  if (bytes.length === 0) {
    return refuse('empty', 'the upload is empty');
  }
  if (bytes.length > maxBytes) {
    return refuse('too-large', `the upload is ${bytes.length} bytes; the cap is ${maxBytes}`);
  }

  const format = detectFormat(bytes);
  if (format === null) {
    return refuse('unsupported-format', 'the upload is not a PNG or JPEG image');
  }

  const dimensions = format === 'png' ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (dimensions === null) {
    return refuse('undecodable', `the upload declares itself ${format} but its header is unreadable`);
  }

  const { width, height } = dimensions;
  if (width <= 0 || height <= 0) {
    return refuse('undecodable', `the image reports a non-positive dimension (${width}×${height})`);
  }
  if (width > maxDimension || height > maxDimension || width * height > maxPixels) {
    return refuse(
      'dimensions-too-large',
      `the image is ${width}×${height}; the caps are ${maxDimension} per side and ${maxPixels} pixels`,
    );
  }

  return { ok: true, format, width, height, contentType: format === 'png' ? 'image/png' : 'image/jpeg' };
}

function refuse(reason: UploadRejection, message: string): UploadRefused {
  return { ok: false, reason, message };
}

/**
 * The image format these bytes are, by content, or `null` if neither PNG nor JPEG. Exported so the
 * runner can recover the media type of an already-validated upload from the blob it stored, without
 * re-running the full validation or keeping a format column beside the bytes.
 */
export function imageFormatOf(bytes: Buffer): ImageFormat | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  // JPEG starts with the SOI marker FF D8, and every JPEG's next byte is FF (the first segment
  // marker). Checking the third byte too rejects a bare "FF D8" that is not actually a JPEG stream.
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

function detectFormat(bytes: Buffer): ImageFormat | null {
  return imageFormatOf(bytes);
}

// ---------------------------------------------------------------------------
// Multipart: several images in one upload (Q26)
//
// A chart may span several pages, applied in page order (ADR-0018, Q26). The job model has been
// n-image-ready since V10 (`imageKeys[]`); V11 opens the transport to match, so `sbscore import a.png
// b.png` and the browser's multi-file picker both land one job whose pages are in order.
//
// `multipart/form-data` is the interoperable envelope for that — it is exactly what a browser
// `<input type="file" multiple>` produces and what `fetch` sends for a `FormData` — so it is parsed
// here rather than inventing a private framing. Like the rest of this module it is hand-rolled and
// dependency-free (the codec owns its XML reader, the engraver its metrics): the subset a file upload
// actually uses is a short, total byte scan, and it keeps the one package ADR-0006 holds thin free of
// a body-parser dependency.
// ---------------------------------------------------------------------------

/** The `boundary=…` token of a `multipart/form-data` content-type header, or `null` if it is not one. */
export function multipartBoundary(contentType: string | undefined): string | null {
  if (contentType === undefined) return null;
  const [type, ...params] = contentType.split(';').map((s) => s.trim());
  if (type?.toLowerCase() !== 'multipart/form-data') return null;
  for (const param of params) {
    const match = /^boundary=("?)([^"]+)\1$/i.exec(param);
    if (match) return match[2]!;
  }
  return null;
}

/**
 * Pull the file parts out of a `multipart/form-data` body, in order. A file part is one whose
 * `Content-Disposition` carries a `filename` (a plain form field has none); its raw bytes are
 * returned untouched, for `validateUpload` to decode. Non-file fields are ignored. Total: it never
 * throws, and a malformed body yields whatever complete parts it could read (an empty list refuses
 * the upload at the route).
 */
export function parseMultipartImages(bytes: Buffer, boundary: string): Buffer[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const images: Buffer[] = [];

  let cursor = bytes.indexOf(delimiter);
  if (cursor === -1) return images;
  cursor += delimiter.length;

  const CRLF = Buffer.from('\r\n');
  const HEADER_END = Buffer.from('\r\n\r\n');

  while (cursor < bytes.length) {
    // Right after a delimiter: `--` closes the body; otherwise a CRLF then the part's headers.
    if (bytes[cursor] === 0x2d && bytes[cursor + 1] === 0x2d) break;
    if (bytes.subarray(cursor, cursor + 2).equals(CRLF)) cursor += 2;

    const headerEnd = bytes.indexOf(HEADER_END, cursor);
    if (headerEnd === -1) break;
    const headers = bytes.subarray(cursor, headerEnd).toString('utf8');
    const bodyStart = headerEnd + HEADER_END.length;

    const nextDelimiter = bytes.indexOf(delimiter, bodyStart);
    if (nextDelimiter === -1) break;
    // The bytes between the header block and the next delimiter, less the CRLF that precedes it.
    let bodyEnd = nextDelimiter;
    if (bytes.subarray(bodyEnd - 2, bodyEnd).equals(CRLF)) bodyEnd -= 2;

    if (/content-disposition:[^\n]*\bfilename=/i.test(headers)) {
      images.push(Buffer.from(bytes.subarray(bodyStart, bodyEnd)));
    }
    cursor = nextDelimiter + delimiter.length;
  }
  return images;
}

/**
 * PNG dimensions live in the IHDR chunk, which the spec requires to be first: an 8-byte signature,
 * then the chunk's 4-byte length, the 4-byte type `IHDR`, then width and height as big-endian
 * uint32s. So they are at fixed offsets 16 and 20, if the file is long enough to hold them.
 */
function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * JPEG dimensions live in a Start-Of-Frame segment (SOF0…SOF15, marker FF C0–FF CF, excluding the
 * DHT/JPG/DAC markers C4/C8/CC which are not frames). Everything before it is other segments, each
 * `FF <marker> <2-byte length> <length-2 bytes of payload>`, so we walk segment by segment skipping
 * payloads until we reach an SOF, then read precision(1), height(2 BE), width(2 BE). Standalone
 * markers (RSTn, SOI, EOI, TEM) carry no length and are skipped as two bytes.
 */
function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2; // past the SOI marker (FF D8).
  const length = bytes.length;
  while (offset + 1 < length) {
    if (bytes[offset] !== 0xff) return null; // not aligned on a marker — malformed.
    // Runs of 0xFF are allowed as fill bytes before a marker; skip them to the real marker byte.
    let marker = bytes[offset + 1] as number;
    let markerAt = offset + 1;
    while (marker === 0xff && markerAt + 1 < length) {
      markerAt += 1;
      marker = bytes[markerAt] as number;
    }

    // Standalone markers with no payload: SOI (D8), EOI (D9), TEM (01), RSTn (D0–D7).
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset = markerAt + 1;
      continue;
    }

    const segmentLengthAt = markerAt + 1;
    if (segmentLengthAt + 1 >= length) return null;
    const segmentLength = bytes.readUInt16BE(segmentLengthAt);
    if (segmentLength < 2) return null;

    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // payload: precision(1) height(2) width(2), starting right after the 2-byte length field.
      const payloadAt = segmentLengthAt + 2;
      if (payloadAt + 5 > length) return null;
      const height = bytes.readUInt16BE(payloadAt + 1);
      const width = bytes.readUInt16BE(payloadAt + 3);
      return { width, height };
    }

    offset = segmentLengthAt + segmentLength;
  }
  return null;
}
