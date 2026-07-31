import { createHash } from 'node:crypto';
import { DEFAULT_MUSIC_FONT, MUSIC_FONT_NAMES } from '@sibei/engrave';
import type { MusicFontName } from '@sibei/engrave';
import { PAPER_SIZES } from '@sibei/layout';
import type { Paper } from '@sibei/layout';
import type { Id, Score } from '@sibei/model';
import { renderScoreToPdf } from '@sibei/pdf';
import type { BlobKey, BlobStore } from '../blob/blob-store.js';
import type { Owner, ScoreReader, ScoreRecord } from '../store/repository.js';

/**
 * Export from the store (V3, R0) — the first path that runs a stored chart all the way to a
 * printable page.
 *
 * `packages/api` is the first package allowed to be impure, and this is what that buys: it holds
 * a `ScoreReader` on one side and `@sibei/pdf` on the other, and `layout`, `engrave` and `pdf`
 * stay pure behind it. The seam runs the other way too — nothing here decides anything about the
 * page, it just hands a `Score` to the render path (ADR-0014).
 *
 * **An export is a read.** It loads through the reader, renders, and caches; it cannot reach a
 * `ScoreWriter` and it must never bump the score's `version` — a generated artefact is not an
 * edit, the same distinction ADR-0028's migration write-back turns on.
 */

export const EXPORT_FORMATS = ['pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * Which written part to render. `concert` is the score as stored, which is all V3 can produce:
 * ADR-0016 makes an instrument part a **render-time view** over transposition, and transposition
 * is V6.
 *
 * It is a parameter and a key component now regardless, because Q81 fixes the cache key at
 * `(score version, format, instrument)`. Leaving the third component out until something used it
 * would make V6 a cache-key migration rather than one more value in a key that already had room.
 */
export const EXPORT_INSTRUMENTS = ['concert'] as const;
export type ExportInstrument = (typeof EXPORT_INSTRUMENTS)[number];

/**
 * The paper and the face, both taken from the packages that own them rather than restated here.
 * A list an error message quotes has to be the list the renderer can actually honour, so it is
 * derived — the same principle as the projection's legend being built from a real object.
 *
 * Q38 wants A4 and Letter with A4 the default. ADR-0030 makes the face **the reader's choice per
 * render, never a build-time constant**, because a lead sheet is read in a handwritten Real Book
 * face as often as an engraved one — so an export endpoint that could only emit the engraved one
 * would contradict a decision of record.
 */
export const EXPORT_PAPERS = Object.keys(PAPER_SIZES) as readonly Paper[];
export const EXPORT_FONTS = MUSIC_FONT_NAMES;

export const DEFAULT_FORMAT: ExportFormat = 'pdf';
export const DEFAULT_INSTRUMENT: ExportInstrument = 'concert';
export const DEFAULT_PAPER: Paper = 'a4';
export const DEFAULT_FONT: MusicFontName = DEFAULT_MUSIC_FONT;

/** Everything that changes the bytes, which is exactly what the cache key is made of. */
export interface ExportRequest {
  format: ExportFormat;
  instrument: ExportInstrument;
  paper: Paper;
  font: MusicFontName;
}

export interface Artefact {
  /** The blob key the bytes live under. Exposed because it is the cache's whole contract (Q81). */
  key: BlobKey;
  contentType: string;
  /** A download name, safe to put in a header. */
  filename: string;
  bytes: Buffer;
  /** True when the bytes came out of the blob store rather than being rendered just now. */
  cached: boolean;
  /** The score version the artefact was rendered from, which is the first part of its key. */
  version: number;
}

export type ExportOutcome =
  | { ok: true; artefact: Artefact }
  | { ok: false; reason: 'no-such-score' };

export interface Exporter {
  export(owner: Owner, id: Id, request: ExportRequest): Promise<ExportOutcome>;
}

const CONTENT_TYPES: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
};

/**
 * The cache key. Q81's three — the score's version, the format, the instrument — plus a digest of
 * the document, the paper and the face.
 *
 * **There is no invalidation logic anywhere, and that is the design.** An edit bumps the score's
 * version (ADR-0003), which changes the key, which means the next export misses and renders — no
 * code had to notice the edit and no code could have failed to. Invalidation logic is the thing
 * that gets it wrong, so the only correct amount of it is none.
 *
 * The rule the three additions follow is one rule: **anything that changes the bytes is in the
 * key.** A key that named fewer things than the render depended on would hand somebody a Letter
 * request and an A4 page, and never tell them.
 *
 * - **The digest** is here because Q81 as written has a hole. Deleting a score destroys its log
 *   (ADR-0003), so a new chart created under the same id starts again at version 1: id and
 *   version together are not unique over time, and without something naming the document the
 *   second chart is served the first one's PDF. `tests/api` carries that case. It adds no
 *   invalidation — it makes the key name the exact bytes it stands for, which is strictly
 *   stronger than Q81's mechanism rather than a different one, and if the serialisation ever
 *   varied the cost would be a miss and never wrong bytes.
 * - **The paper and the face** are amendments to Q81 for the same reason `instrument` was in the
 *   key before anything could vary it: leaving a component out until something used it makes the
 *   slice that uses it a cache-key migration. Q81 predates ADR-0030, which is what makes the face
 *   a render-time parameter rather than a constant; Q38 is what makes the paper one.
 *
 * The id goes in as a scope rather than as a component, percent-encoded so two ids cannot collide
 * by containing the separator.
 */
export function exportBlobKey(
  id: Id,
  record: Pick<ScoreRecord, 'score' | 'version'>,
  request: ExportRequest,
): BlobKey {
  return [
    'export',
    encodeURIComponent(id),
    `v${String(record.version)}`,
    documentDigest(record.score),
    request.instrument,
    request.paper,
    request.font,
    request.format,
  ].join(':');
}

function documentDigest(score: Score): string {
  return createHash('sha256').update(JSON.stringify(score), 'utf8').digest('hex').slice(0, 16);
}

export function createExporter(reader: ScoreReader, blobs: BlobStore): Exporter {
  return {
    async export(owner, id, request) {
      const record = reader.get(owner, id);
      if (record === null) return { ok: false, reason: 'no-such-score' };

      const key = exportBlobKey(id, record, request);
      const describe = (bytes: Buffer, cached: boolean): ExportOutcome => ({
        ok: true,
        artefact: {
          key,
          contentType: CONTENT_TYPES[request.format],
          filename: downloadName(record.score, request.format),
          bytes,
          cached,
          version: record.version,
        },
      });

      const hit = await blobs.get(key);
      if (hit !== null) return describe(hit, true);

      const bytes = await render(record.score, request);
      await blobs.put(key, bytes);
      return describe(bytes, false);
    },
  };
}

function render(score: Score, request: ExportRequest): Promise<Buffer> {
  switch (request.format) {
    case 'pdf':
      // The page spec and the render options, straight through. Nothing here decides anything
      // about the page — that is `layout`'s, and the seam only holds while the API stays a
      // conduit for the choice rather than a second opinion about it (ADR-0014).
      return renderScoreToPdf(score, { paper: request.paper }, { font: request.font });
    default:
      return exhaustive(request.format);
  }
}

function exhaustive(format: never): never {
  throw new Error(`unhandled export format: ${JSON.stringify(format)}`);
}

/**
 * A download name from the chart's title.
 *
 * Sanitised down to a conservative set rather than escaped, because this ends up in a
 * `Content-Disposition` header: a title holding a quote or a newline would otherwise be a way for
 * whoever named the chart to write a header of their own.
 */
function downloadName(score: Score, format: ExportFormat): string {
  const stem = score.meta.title
    .replace(/[^A-Za-z0-9 _-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60);
  return `${stem === '' ? 'score' : stem}.${format}`;
}

/** The query value, or null when it is not a format this build can produce. */
export function parseExportFormat(raw: string | null): ExportFormat | null {
  if (raw === null || raw === '') return DEFAULT_FORMAT;
  return EXPORT_FORMATS.find((format) => format === raw) ?? null;
}

export function parseExportInstrument(raw: string | null): ExportInstrument | null {
  if (raw === null || raw === '') return DEFAULT_INSTRUMENT;
  return EXPORT_INSTRUMENTS.find((instrument) => instrument === raw) ?? null;
}

/**
 * A4 unless asked otherwise (Q38). Null rather than the default for a value that is not a paper:
 * silently falling back would hand somebody a Letter request and an A4 page without telling them.
 */
export function parseExportPaper(raw: string | null): Paper | null {
  if (raw === null || raw === '') return DEFAULT_PAPER;
  return EXPORT_PAPERS.find((paper) => paper === raw) ?? null;
}

/** The engraved face unless asked for the handwritten one (ADR-0030). Same no-fallback rule. */
export function parseExportFont(raw: string | null): MusicFontName | null {
  if (raw === null || raw === '') return DEFAULT_FONT;
  return EXPORT_FONTS.find((font) => font === raw) ?? null;
}
