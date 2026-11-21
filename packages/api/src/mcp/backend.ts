import {
  EXPORT_FONTS,
  EXPORT_FORMATS,
  EXPORT_INSTRUMENTS,
  EXPORT_PAPERS,
  parseExportFont,
  parseExportFormat,
  parseExportInstrument,
  parseExportPaper,
} from '../export/export.js';
import type { Exporter } from '../export/export.js';
import { problemForUnknown } from '../http/problems.js';
import { batchFrom } from '../http/routes.js';
import type { Applier } from '../ops/applier.js';
import type { Owner, ScoreReader } from '../store/repository.js';
import { McpToolError } from './tools.js';
import type { ExportChoices, McpBackend } from './tools.js';

/**
 * The server's own {@link McpBackend}: the tools of `/mcp` run straight onto the services the `/v1/` routes
 * use, for **one owner**, fixed when the backend is made from the request's token.
 *
 * There is no second write path here (ADR-0003). A write is `applier.apply`, `undo` or `redo`, the same
 * calls `routes.ts` makes with the same batch shape (`batchFrom`), so a stale version, an address miss or a
 * validation failure is refused by the applier and reported with the same `kind`, `detail`,
 * `currentVersion` and `operation` the `/v1/` API would answer — this file only carries it across as an
 * {@link McpToolError} instead of an HTTP status. Every call takes the owner this backend was made for, so
 * a tool has no way to name another owner's score: the store answers `no-such-score` for it, as for a
 * score that does not exist.
 *
 * It is handed an `Applier`, a `ScoreReader` and an `Exporter` and nothing wider — no store, no
 * `ScoreWriter` — so `tests/arch` can hold the line the same way it does for `routes.ts`.
 */

export interface ServerBackendOptions {
  owner: Owner;
  reader: ScoreReader;
  applier: Applier;
  exporter: Exporter;
  /** Told of a failure the API has no word for (a 5xx), so the log has the detail the tool result leaves out. */
  onError?: (error: unknown) => void;
}

export function createServerBackend(options: ServerBackendOptions): McpBackend {
  const { owner, reader, applier, exporter } = options;

  /** Run one call, turning whatever it throws into the API's own error object. */
  async function guard<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof McpToolError) throw error;
      const { status, body } = problemForUnknown(error);
      if (status >= 500) options.onError?.(error);
      const { kind, message, ...extra } = body.error;
      throw new McpToolError(kind, message, extra);
    }
  }

  const noSuchScore = (id: string): McpToolError =>
    new McpToolError('no-such-score', `there is no score with the id ${JSON.stringify(id)}`);

  return {
    list: () => guard(async () => ({ scores: await reader.list(owner) })),

    read: (id) =>
      guard(async () => {
        const record = await reader.get(owner, id);
        if (record === null) throw noSuchScore(id);
        return { score: record.score, version: record.version, updatedAt: record.updatedAt };
      }),

    create: (operations) => guard(() => applier.apply(owner, null, batchFrom({ operations }))),

    apply: (id, operations, expectedVersion) =>
      guard(() => applier.apply(owner, id, batchFrom({ operations, expectedVersion }))),

    undo: (id, expectedVersion) => guard(() => applier.undo(owner, id, expectedVersion)),

    redo: (id, expectedVersion) => guard(() => applier.redo(owner, id, expectedVersion)),

    exportScore: (id, choices) =>
      guard(async () => {
        const request = exportRequest(choices);
        const outcome = await exporter.export(owner, id, request);
        if (!outcome.ok) throw noSuchScore(id);
        const { bytes, contentType, filename } = outcome.artefact;
        return { bytes, contentType, filename };
      }),
  };
}

/** The same four parse-or-refuse steps the export route takes, with the same `unsupported-*` failures. */
function exportRequest(choices: ExportChoices) {
  const refuse = (what: string, requested: string | undefined, supported: readonly string[]): McpToolError => {
    const kind = `unsupported-${what}`;
    return new McpToolError(
      kind,
      `${JSON.stringify(requested ?? '')} is not an export ${what} this build can produce; try ${supported.join(' or ')}`,
      { detail: { kind, requested: requested ?? null, supported: [...supported] } },
    );
  };
  const format = parseExportFormat(choices.format ?? null);
  // SVG is one page at a time and the MCP tool has no page choice, so it stays a CLI/HTTP format (SIB2-190).
  if (format === null || format === 'svg') throw refuse('format', choices.format, EXPORT_FORMATS.filter((f) => f !== 'svg'));
  const instrument = parseExportInstrument(choices.instrument ?? null);
  if (instrument === null) throw refuse('instrument', choices.instrument, EXPORT_INSTRUMENTS);
  const paper = parseExportPaper(choices.paper ?? null);
  if (paper === null) throw refuse('paper', choices.paper, EXPORT_PAPERS);
  const font = parseExportFont(choices.font ?? null);
  if (font === null) throw refuse('font', choices.font, EXPORT_FONTS);
  return { format, instrument, paper, font };
}
