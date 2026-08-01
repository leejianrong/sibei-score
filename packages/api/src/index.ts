/**
 * The package's surface, and everything on it runs with nothing installed.
 *
 * The SQLite adapter is deliberately **not** here — it lives at `@sibei/api/sqlite`, because it
 * is the one thing in the package that loads a compiled native binding and this barrel is what
 * a pure test reaches for. See `sqlite.ts` for the reasoning (ADR-0006, KAN-514), and
 * `tests/arch/fast-layer-purity.test.ts` for the guard that keeps it true.
 */

export * from './store/repository.js';

export type { BlobKey, BlobStore } from './blob/blob-store.js';
export { memoryBlobStore } from './blob/memory-blob-store.js';
export { openDirectoryBlobStore } from './blob/directory-blob-store.js';
export type { DirectoryBlobStoreOptions } from './blob/directory-blob-store.js';

export {
  DEFAULT_FONT,
  DEFAULT_FORMAT,
  DEFAULT_INSTRUMENT,
  DEFAULT_PAPER,
  EXPORT_FONTS,
  EXPORT_FORMATS,
  EXPORT_INSTRUMENTS,
  EXPORT_PAPERS,
  createExporter,
  exportBlobKey,
  parseExportFont,
  parseExportFormat,
  parseExportInstrument,
  parseExportPaper,
} from './export/export.js';
export type {
  Artefact,
  ExportFormat,
  ExportInstrument,
  ExportOutcome,
  ExportRequest,
  Exporter,
} from './export/export.js';

export * from './ops/operations.js';
export * from './ops/errors.js';
export { applyOperation, replay, DEFAULT_BAR_COUNT } from './ops/apply.js';
export type { Applied } from './ops/apply.js';
export { createApplier } from './ops/applier.js';
export type { Applier, ApplyResult } from './ops/applier.js';

export { createApi } from './http/server.js';
export type { Api, ApiOptions } from './http/server.js';
export {
  LOOPBACK,
  checkHost,
  checkOrigin,
  isStateChanging,
  resolveLocalPrincipal,
} from './http/guards.js';
export type { Authenticator, GuardVerdict, Principal } from './http/guards.js';
export { consoleLogger, silentLogger } from './http/log.js';
export type { Logger, RequestLine } from './http/log.js';
