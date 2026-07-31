import { SCHEMA_VERSION } from './score.js';
import type { Score } from './score.js';

/**
 * Forward-only document migrations, run on read (ADR-0028).
 *
 * Every score document carries `schemaVersion`. A document below the current version is
 * migrated in memory, used, and written back at the current version. A document from a
 * *newer* version than the running code is a hard error, not a best-effort read — the data
 * is irreplaceable and quiet corruption is the worst outcome available.
 *
 * Framework-free like the rest of `model`: this is pure shape arithmetic, and the *reading*
 * and *writing back* belong to the repository (`@sibei/api`).
 */

/**
 * A document as it came off the wire or out of the store: JSON, shape not yet trusted.
 * Migrations traffic in this rather than in `Score`, because a document at version N-1 is
 * by definition not a `Score` — that is the whole point of migrating it.
 */
export type RawDocument = Record<string, unknown>;

/**
 * One step of the chain. Pure, from `from` to `from + 1`, and it may assume its input is a
 * document at exactly `from` because the runner guarantees it.
 *
 * ADR-0028's standing tax: every model change that alters the document shape owes one of
 * these plus a fixture that gets carried through it.
 */
export interface DocumentMigration {
  from: number;
  /** Why the shape changed. Read by nobody at runtime; read by everybody at 2am. */
  note: string;
  migrate(document: RawDocument): RawDocument;
}

/**
 * The chain, in order. Empty because `SCHEMA_VERSION` has been 1 since the first commit and
 * nothing has changed the shape yet. The runner below is exercised anyway, against a
 * synthetic chain, so the machinery is known to work before there is a real migration
 * riding on it.
 */
export const DOCUMENT_MIGRATIONS: readonly DocumentMigration[] = [];

/** Why a document could not be read. Distinguished so a caller can say something useful. */
export type MigrationFailure =
  | { kind: 'not-a-document'; detail: string }
  | { kind: 'missing-version'; detail: string }
  | { kind: 'from-the-future'; found: number; supported: number }
  | { kind: 'no-migration'; from: number; target: number };

export class DocumentMigrationError extends Error {
  readonly failure: MigrationFailure;

  constructor(failure: MigrationFailure) {
    super(describe(failure));
    this.name = 'DocumentMigrationError';
    this.failure = failure;
  }
}

function describe(failure: MigrationFailure): string {
  switch (failure.kind) {
    case 'not-a-document':
      return `not a score document: ${failure.detail}`;
    case 'missing-version':
      return `score document has no usable schemaVersion: ${failure.detail}`;
    case 'from-the-future':
      return (
        `score document is at schema version ${failure.found}, but this build only ` +
        `understands ${failure.supported}. Refusing to guess — upgrade the app rather ` +
        `than reading it with an older one.`
      );
    case 'no-migration':
      return (
        `score document is at schema version ${failure.from}, and there is no migration ` +
        `from ${failure.from} to ${failure.from + 1} on the way to ${failure.target}.`
      );
  }
}

export interface MigrationResult {
  score: Score;
  /**
   * Whether the chain actually ran. The repository writes back only when this is true, and
   * that write-back must not bump the score's `version` — a migration is not an edit
   * (ADR-0028, ADR-0003).
   */
  migrated: boolean;
  /** The version the document arrived at, for a log line or a test. */
  from: number;
}

/**
 * The runner, with its chain and target injected. `migrateDocument` binds the real ones;
 * this form exists so a test can carry a fixture through a synthetic chain and prove the
 * machinery while `DOCUMENT_MIGRATIONS` is still empty.
 */
export function migrateDocumentWith(
  raw: unknown,
  migrations: readonly DocumentMigration[],
  target: number,
): MigrationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DocumentMigrationError({ kind: 'not-a-document', detail: typeName(raw) });
  }

  let document = { ...(raw as RawDocument) };
  const from = readVersion(document);

  if (from > target) {
    throw new DocumentMigrationError({ kind: 'from-the-future', found: from, supported: target });
  }

  for (let version = from; version < target; version += 1) {
    const step = migrations.find((migration) => migration.from === version);
    if (step === undefined) {
      throw new DocumentMigrationError({ kind: 'no-migration', from: version, target });
    }
    document = step.migrate(document);
    document.schemaVersion = version + 1;
  }

  return { score: assertScoreShape(document, target), migrated: from !== target, from };
}

/** The runner as production uses it: the real chain, up to `SCHEMA_VERSION`. */
export function migrateDocument(raw: unknown): MigrationResult {
  return migrateDocumentWith(raw, DOCUMENT_MIGRATIONS, SCHEMA_VERSION);
}

function readVersion(document: RawDocument): number {
  const found = document.schemaVersion;
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
    throw new DocumentMigrationError({ kind: 'missing-version', detail: typeName(found) });
  }
  return found;
}

/**
 * A narrow structural check, not a schema validator. Enough that a truncated file or a
 * migration that returned the wrong thing fails here rather than three layers up wearing a
 * `Score` type it does not deserve. Field-level validation is the op applier's job, on the
 * way in.
 */
function assertScoreShape(document: RawDocument, version: number): Score {
  const problems: string[] = [];
  if (document.schemaVersion !== version) {
    problems.push(`schemaVersion is ${typeName(document.schemaVersion)}, expected ${version}`);
  }
  if (typeof document.id !== 'string' || document.id === '') problems.push('id is not a string');
  if (typeof document.meta !== 'object' || document.meta === null) problems.push('meta is missing');
  if (!Array.isArray(document.bars)) problems.push('bars is not an array');
  if (!Array.isArray(document.sections)) problems.push('sections is not an array');
  if (problems.length > 0) {
    throw new DocumentMigrationError({ kind: 'not-a-document', detail: problems.join('; ') });
  }
  return document as unknown as Score;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}
