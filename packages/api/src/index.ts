export * from './store/repository.js';
export { openSqliteStore } from './store/sqlite-store.js';
export type { SqliteStoreOptions } from './store/sqlite-store.js';
export { TABLE_SCHEMA_VERSION } from './store/sqlite-schema.js';

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
