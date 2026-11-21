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
export { MCP_TOOLS, McpToolError } from './mcp/tools.js';
export type { ExportChoices, ExportedArtefact, McpBackend, McpTool, ToolAccess, ToolResult } from './mcp/tools.js';
export { PARSE_FAILURE, SERVER_INFO, SUPPORTED_PROTOCOLS, handleMcpMessage } from './mcp/protocol.js';
export type { McpSession } from './mcp/protocol.js';
export { API_SCOPES, MCP_SCOPES, TOKEN_SCOPES } from './store/auth.js';
export type { ApiToken, AuthStore, DeviceApproval, DevicePoll, NewApiToken, NewDevice, ProviderProfile, Session, TokenPrincipal, TokenScope, User, UserId } from './store/auth.js';
export type {
  AudioJob,
  AudioJobId,
  AudioJobReader,
  AudioJobStatus,
  AudioJobStore,
  AudioJobSummary,
  AudioJobWriter,
  AudioJobWorkerStore,
  AudioProgress,
  LeaseOutcome,
  NewAudioJob,
} from './store/audio-jobs.js';
export { memoryAudioJobStore } from './store/memory-audio-job-store.js';
export type { MemoryAudioJobStoreOptions } from './store/memory-audio-job-store.js';
export { memoryJobStore } from './store/memory-job-store.js';
export type { MemoryJobStoreOptions } from './store/memory-job-store.js';

export type {
  BlobKey,
  BlobStore,
  ManagedBlobStore,
  PresignedRequest,
  PresignOptions,
  PresigningBlobStore,
} from './blob/blob-store.js';
export { audioCapFor, parseAudioPlans } from './audio/quota.js';
export type { AudioQuotaConfig } from './audio/quota.js';
export { createAudioResultImporter } from './audio/importer.js';
export { createAudioWorkerService, WORKER_TOKEN_PREFIX } from './audio/worker-service.js';
export type {
  AudioResultImporter,
  AudioWorkerOptions,
  AudioWorkerService,
  ClaimedJob,
  WorkerTransfer,
} from './audio/worker-service.js';
export { createAudioService, DEFAULT_AUDIO_LIMITS } from './audio/service.js';
export type { AudioLimits, AudioService, CreateAudioInput, UploadTarget } from './audio/service.js';
export { isPresigning } from './blob/blob-store.js';
export { openS3BlobStore } from './blob/s3-blob-store.js';
export type { S3BlobStore, S3BlobStoreOptions } from './blob/s3-blob-store.js';
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
  EXPORT_PAGE_NUMBER_FORMATS,
  EXPORT_PAGE_NUMBER_POSITIONS,
  EXPORT_PAPERS,
  createExporter,
  exportBlobKey,
  parseExportBarNumbers,
  parseExportBlankStaves,
  parseExportFont,
  parseExportPage,
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
export type { Applier, ApplyResult, UndoResult, DuplicateResult, ImportResult } from './ops/applier.js';

// The OMR import pipeline (V10): the upload boundary, the worker port, and the job runner. The
// worker receives an image and returns raw recognised objects; it never touches the store (ADR-0005).
export {
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  MAX_UPLOAD_BYTES,
  imageFormatOf,
  multipartBoundary,
  parseMultipartImages,
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
export type { JobRunner, JobRunnerOptions, ScoreImporter } from './imports/runner.js';

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

export { createHostedAuth, GITHUB, SESSION_COOKIE } from './auth/hosted.js';
export type { GitHubOptions, HostedAuth, HostedAuthOptions } from './auth/hosted.js';
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

// Rate limits and quotas (V23). The Redis counters and buses are the opt-in `@sibei/api/redis`.
export { DEFAULT_LIMITS, classify, clientAddress, createLimits, DEFAULT_CLASSIFIERS } from './limits/limits.js';
export type { Classifier, LimitRefusal, Limits, LimitsConfig, LimitsOptions, Rate, RequestClass } from './limits/limits.js';
export { limitsFromEnv } from './limits/config.js';
export { memoryRateLimiter } from './limits/rate-limiter.js';
export type { RateLimiter, RateVerdict } from './limits/rate-limiter.js';
export { QuotaError } from './limits/errors.js';
export type { QuotaName } from './limits/errors.js';

// Account deletion and the blob ledger (V25). The SQLite and Postgres ledgers are on their adapter subpaths.
export { createOwnerEraser } from './account/erase.js';
export { DEFAULT_SWEEP_LIFETIMES, createBlobSweeper } from './account/sweep.js';
export type { BlobSweeper, BlobSweeperOptions, SweepLifetimes } from './account/sweep.js';
export type { OwnerEraser, OwnerEraserOptions } from './account/erase.js';
export { memoryBlobLedger } from './store/blob-ledger.js';
export type { BlobLedger, BlobRef } from './store/blob-ledger.js';
