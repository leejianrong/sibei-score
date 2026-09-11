/**
 * The package's surface, and everything on it runs with nothing installed.
 *
 * The SQLite adapter is deliberately **not** here — it lives at `@sibei/api/sqlite`, because it
 * is the one thing in the package that loads a compiled native binding and this barrel is what
 * a pure test reaches for. See `sqlite.ts` for the reasoning (ADR-0006, KAN-514), and
 * `tests/arch/fast-layer-purity.test.ts` for the guard that keeps it true.
 */

export * from './store/repository.js';

export type {
  ImportJob,
  ImportJobSummary,
  JobId,
  JobReader,
  JobStatus,
  JobStore,
  JobWriter,
} from './store/jobs.js';
export { memoryJobStore } from './store/memory-job-store.js';
export type { MemoryJobStoreOptions } from './store/memory-job-store.js';

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
// Parts live in @sibei/music now (V6e), so the browser can render them too; re-exported here so the
// server-side consumers and tests that reached them through @sibei/api still do.
export { PART_INSTRUMENTS, partInterval, partLabel, writtenPart } from '@sibei/music';
export type { PartInstrument } from '@sibei/music';

export * from './ops/operations.js';
export * from './ops/errors.js';
export {
  applyOperation,
  replay,
  replayLog,
  resolveLog,
  effectiveLog,
  DEFAULT_BAR_COUNT,
} from './ops/apply.js';
export type { Applied, UndoState } from './ops/apply.js';
export { createApplier } from './ops/applier.js';
export type { Applier, ApplyResult, UndoResult, DuplicateResult } from './ops/applier.js';

// The OMR import pipeline (V10): the upload boundary, the worker port, and the job runner. The
// worker receives an image and returns raw recognised objects; it never touches the store (ADR-0005).
export {
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  MAX_UPLOAD_BYTES,
  imageFormatOf,
  validateUpload,
} from './imports/upload.js';
export type {
  ImageFormat,
  UploadCaps,
  UploadOk,
  UploadRefused,
  UploadRejection,
  UploadResult,
} from './imports/upload.js';
export { WorkerError, createHttpWorkerClient } from './imports/worker-client.js';
export type { HttpWorkerClientOptions, WorkerClient } from './imports/worker-client.js';
export { INTERRUPTED_DIAGNOSTIC, createJobRunner } from './imports/runner.js';
export type { JobRunner, JobRunnerOptions } from './imports/runner.js';

export {
  createChangeBus,
  publishingApplier,
  publishingLibrary,
} from './events/change-bus.js';
export { createJobBus } from './events/job-bus.js';
export type { JobBus, JobBusOptions, JobChanged, JobListener, JobPublisher, JobSubscriber } from './events/job-bus.js';
export type {
  ChangeBus,
  ChangeBusOptions,
  ChangeEvent,
  ChangeListener,
  ChangePublisher,
  ChangeSubscriber,
  ScoreChanged,
  ScoreDeleted,
} from './events/change-bus.js';

export { createApi } from './http/server.js';
export type { Api, ApiOptions } from './http/server.js';
export { DEFAULT_HEARTBEAT_MS, createEventStreams } from './http/event-stream.js';
export type { EventStreamOptions, EventStreams } from './http/event-stream.js';
export { DEFAULT_JOB_HEARTBEAT_MS, createJobStreams } from './http/job-stream.js';
export type { JobStreamOptions, JobStreams } from './http/job-stream.js';
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
export { serveStaticAsset } from './http/static.js';
export type { Asset, AssetSource } from './http/static.js';
