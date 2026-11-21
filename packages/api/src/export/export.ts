import { createHash } from 'node:crypto';
import { DEFAULT_MUSIC_FONT, MUSIC_FONT_NAMES } from '@sibei/engrave';
import type { MusicFontName } from '@sibei/engrave';
import {
  DEFAULT_PAGE_NUMBERS,
  PAGE_NUMBER_FORMATS,
  PAGE_NUMBER_POSITIONS,
  PAPER_SIZES,
} from '@sibei/layout';
import { layout } from '@sibei/layout';
import type { PageNumberFormat, PageNumberPosition, PageNumberSettings, PageSpecInput, Paper } from '@sibei/layout';
import type { Id, Score } from '@sibei/model';
import { scoreToMusicXml } from '@sibei/codec';
import { renderScoreToPdf, renderScoreToSvg } from '@sibei/pdf';
import type { BlobKey, BlobStore } from '../blob/blob-store.js';
import type { Owner, ScoreReader, ScoreRecord } from '../store/repository.js';
import { PART_INSTRUMENTS, partLabel, writtenPart } from '@sibei/music';
import type { PartInstrument } from '@sibei/music';

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

export const EXPORT_FORMATS = ['pdf', 'musicxml', 'svg'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * Which written part to render. `concert` is the score as stored; the five transposing instruments
 * are **render-time views** over the same concert document (ADR-0016), added in V6c. The list — and
 * the transposition behind each name — is `part.ts`'s, so the cache key, the route's validation and
 * the renderer all agree about what an instrument *is* by construction.
 *
 * This dimension was in the cache key from V3 with only `concert` in it (Q81), precisely so that
 * turning it on here was one more value in a key that already had room rather than a cache-key
 * migration.
 */
export const EXPORT_INSTRUMENTS = PART_INSTRUMENTS;
export type ExportInstrument = PartInstrument;

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
  /** Page numbers on the PDF (SIB2-171). Absent or null: none, as before. A render choice, not part of the score. */
  pageNumbers?: PageNumberSettings | null;
  /**
   * Which page an `svg` export is, 1-based; absent is page 1. An SVG is one page (the browser's own markup), so a
   * chart of several is fetched a page at a time and the artefact says how many there are (SIB2-190).
   */
  page?: number;
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
  /** How many pages the chart has under this request's page settings: set for `svg`, which is one page at a time. */
  pages?: number;
}

export type ExportOutcome =
  | { ok: true; artefact: Artefact }
  | { ok: false; reason: 'no-such-score' }
  | { ok: false; reason: 'no-such-page'; pages: number };

export interface Exporter {
  export(owner: Owner, id: Id, request: ExportRequest): Promise<ExportOutcome>;
}

const CONTENT_TYPES: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  // The registered type for uncompressed MusicXML (a `.musicxml` file), which is what MuseScore and
  // the like sniff for. `application/xml` would open too, but this is the one the format owns.
  musicxml: 'application/vnd.recordare.musicxml+xml',
  // The browser's own page markup, byte for byte (SIB2-190): `layout` + `engrave`, the one render path.
  svg: 'image/svg+xml',
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
  owner?: Owner,
): BlobKey {
  return [
    'export',
    // The owner scopes the key (V25), so two accounts' artefacts are never the same blob and deleting one
    // account's cannot cost the other a cache hit. Omitted only by the callers that predate tenancy.
    ...(owner === undefined ? [] : [encodeURIComponent(owner)]),
    encodeURIComponent(id),
    `v${String(record.version)}`,
    documentDigest(record.score),
    request.instrument,
    request.paper,
    request.font,
    request.format,
    // The last component, and absent when there are none, so every key made before page numbers existed is
    // still the key for the same bytes. A PDF's page numbers change them; MusicXML ignores them.
    // Which page an SVG is. Only an SVG has one, and it is last, so no PDF or MusicXML key changes.
    ...(request.format === 'svg' ? [`page-${String(request.page ?? 1)}`] : []),
    ...(request.format !== 'musicxml' && request.pageNumbers
      ? [`pn-${request.pageNumbers.position}-${request.pageNumbers.format}-${request.pageNumbers.first ? 'first' : 'skip'}`]
      : []),
  ].join(':');
}

function documentDigest(score: Score): string {
  return createHash('sha256').update(JSON.stringify(score), 'utf8').digest('hex').slice(0, 16);
}

/**
 * `onStore` is told each time an artefact is written to the cache, so the caller can record the blob
 * against its owner (the blob ledger, V25) and account deletion can find it.
 */
export function createExporter(
  reader: ScoreReader,
  blobs: BlobStore,
  onStore?: (owner: Owner, key: BlobKey) => Promise<void>,
): Exporter {
  return {
    async export(owner, id, request) {
      const record = await reader.get(owner, id);
      if (record === null) return { ok: false, reason: 'no-such-score' };

      const key = exportBlobKey(id, record, request, owner);
      const describe = (bytes: Buffer, cached: boolean, pages?: number): ExportOutcome => ({
        ok: true,
        artefact: {
          key,
          contentType: CONTENT_TYPES[request.format],
          filename: downloadName(record.score, request.format, request.instrument, request.page),
          bytes,
          cached,
          version: record.version,
          ...(pages === undefined ? {} : { pages }),
        },
      });

      const part = writtenPart(record.score, request.instrument);
      // An SVG is one page, so say how many there are and refuse one that is not there, hit or miss.
      const pages = request.format === 'svg' ? svgPageCount(part, request) : undefined;
      if (pages !== undefined && (request.page ?? 1) > pages) return { ok: false, reason: 'no-such-page', pages };

      const hit = await blobs.get(key);
      if (hit !== null) return describe(hit, true, pages);

      // The one place a part is produced: the stored concert score is turned into its written view
      // just before rendering, and never persisted (ADR-0016). `concert` returns it untouched.
      const bytes = await render(part, request);
      await blobs.put(key, bytes);
      await onStore?.(owner, key);
      return describe(bytes, false, pages);
    },
  };
}

/** The page choices an export carries, as the layout takes them. Nothing here decides anything about the page. */
function pageSpecOf(request: ExportRequest): PageSpecInput {
  return { paper: request.paper, pageNumbers: request.pageNumbers ?? null };
}

/** How many pages the chart has under this request, from `layout` alone (a cache hit renders nothing). */
function svgPageCount(score: Score, request: ExportRequest): number {
  return layout(score, pageSpecOf(request)).pages.length;
}

function render(score: Score, request: ExportRequest): Promise<Buffer> {
  switch (request.format) {
    case 'pdf':
      // The page spec and the render options, straight through. Nothing here decides anything
      // about the page — that is `layout`'s, and the seam only holds while the API stays a
      // conduit for the choice rather than a second opinion about it (ADR-0014).
      return renderScoreToPdf(score, pageSpecOf(request), { font: request.font });
    case 'svg': {
      // The same `layout` + `engrave` the browser composes (ADR-0014/0015), so this is its SVG, byte for byte.
      const page = renderScoreToSvg(score, pageSpecOf(request), { font: request.font })[(request.page ?? 1) - 1];
      if (page === undefined) throw new Error(`no page ${String(request.page)} to render`);
      return Promise.resolve(Buffer.from(page.svg, 'utf8'));
    }
    case 'musicxml':
      // A codec at the edge (ADR-0004), not a render: MusicXML is text off the score, so paper and
      // font do not enter into it. `writtenPart` already applied above, so a part exports transposed.
      return Promise.resolve(Buffer.from(scoreToMusicXml(score), 'utf8'));
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
function downloadName(score: Score, format: ExportFormat, instrument: ExportInstrument, page?: number): string {
  const stem = score.meta.title
    .replace(/[^A-Za-z0-9 _-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60);
  // A part names its instrument, because a folder full of `Body and Soul.pdf` is useless the moment
  // you export more than one. The concert score keeps the bare title.
  const part = instrument === 'concert' ? '' : ` - ${partLabel(instrument)}`;
  // An SVG is one page of several, so its name says which (`Body and Soul - page 2.svg`).
  const which = format === 'svg' ? ` - page ${String(page ?? 1)}` : '';
  return `${stem === '' ? 'score' : stem}${part}${which}.${format}`;
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

/**
 * `page=N` (SIB2-190): which page an `svg` export is. 1 unless named; a positive whole number or null
 * (a 422). A page past the end is the exporter's to judge, since only it knows how many there are.
 */
export function parseExportPage(raw: string | null): number | null {
  if (raw === null || raw === '') return 1;
  return /^[1-9]\d{0,3}$/.test(raw) ? Number(raw) : null;
}

export const EXPORT_PAGE_NUMBER_POSITIONS = PAGE_NUMBER_POSITIONS;
export const EXPORT_PAGE_NUMBER_FORMATS = PAGE_NUMBER_FORMATS;

/**
 * `pagenumbers=none|top-right|…` — none unless asked for (SIB2-171), so existing output is
 * unchanged. Returns `undefined` for a position that is not one (a 422), `null` for none.
 */
export function parseExportPageNumberPosition(raw: string | null): PageNumberPosition | null | undefined {
  if (raw === null || raw === '' || raw === 'none') return null;
  return EXPORT_PAGE_NUMBER_POSITIONS.find((position) => position === raw);
}

export function parseExportPageNumberFormat(raw: string | null): PageNumberFormat | null {
  if (raw === null || raw === '') return DEFAULT_PAGE_NUMBERS.format;
  return EXPORT_PAGE_NUMBER_FORMATS.find((format) => format === raw) ?? null;
}

/** `yes` (the default) or `no`: whether page 1 carries a number. */
export function parseExportPageNumberFirst(raw: string | null): boolean | null {
  if (raw === null || raw === '' || raw === 'yes') return true;
  return raw === 'no' ? false : null;
}
