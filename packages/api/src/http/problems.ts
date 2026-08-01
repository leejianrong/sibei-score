import { DocumentMigrationError } from '@sibei/model';
import { OperationError } from '../ops/errors.js';
import type { OperationFailure } from '../ops/errors.js';

/**
 * Turning a failure into a response.
 *
 * ADR-0008 requires the distinctions to be branchable **without parsing prose**, because the
 * difference between an agent that self-corrects and one that retries blind is whether the error
 * told it what to do. So every response carries a stable `kind`, a human message, and the whole
 * structured `detail` — an address miss brings the bar's real onsets along with it.
 */

export interface Problem {
  status: number;
  body: {
    error: {
      /** Stable machine-readable discriminator. The thing to branch on. */
      kind: string;
      message: string;
      /** The structured failure, verbatim. Whatever the resolver or applier knew, the client knows. */
      detail?: unknown;
      /**
       * Present on a 409 from a stale write: what to re-read at (ADR-0003).
       *
       * **The same number is inside `detail` as `current`, and that overlap is deliberate** — it was
       * looked at again for KAN-607 and kept. `detail` is the structured failure *verbatim*, so
       * trimming a field out of it would make it a curated view and break the one rule it has; and
       * this field is the promoted, named one the ADR promises, which the CLI reads and reports flat
       * because `detail.detail.detail` was the bug that shape was introduced to fix. A client may
       * read either, so dropping one would be a breaking change for no gain. `expected` stays inside
       * `detail` alone: the client sent it and does not need it handed back.
       */
      currentVersion?: number;
      /** 1-based position in a batch, when one operation of several was at fault. */
      operation?: number;
    };
  };
}

export function problem(status: number, kind: string, message: string, extra: Partial<Problem['body']['error']> = {}): Problem {
  return { status, body: { error: { kind, message, ...extra } } };
}

/** The status an operation failure deserves. The 409 is the one that carries a version. */
export function problemForOperationError(error: OperationError): Problem {
  const failure = error.failure;
  const base: Partial<Problem['body']['error']> = {
    detail: failure,
    ...(error.index === undefined ? {} : { operation: error.index + 1 }),
  };

  switch (failure.kind) {
    case 'stale-version':
      // The headline of ADR-0003: a stale write is refused *along with the current version*, so
      // the client can re-read and retry rather than guess.
      return problem(409, failure.kind, error.message, {
        ...base,
        currentVersion: failure.current,
      });
    case 'conflict-exists':
      return problem(409, failure.kind, error.message, base);
    case 'no-such-score':
      return problem(404, failure.kind, error.message, base);
    // 422 and not 409, which is the one worth arguing (KAN-607). 409 means "you and the store
    // disagree about the version, here is the current one" — but there is nothing to disagree with
    // when no version was sent, and a client retrying a 409 would be retrying with a field it never
    // filled in. It is not 400 either: the body was perfectly readable JSON. What is wrong is the
    // *content* of a well-formed request, which is exactly what 422 means here already. And unlike
    // the 409 it carries no `currentVersion`: see `missing-expected-version` in ops/errors.ts.
    case 'missing-expected-version':
    case 'address':
    case 'validation':
    case 'unknown-operation':
    case 'bad-target':
    case 'bad-first-operation':
      // 422 rather than 400: the request was well-formed JSON and the server understood it. It was
      // the *content* that could not be applied, which is a different thing for a client to handle.
      return problem(422, failure.kind, error.message, base);
    default:
      return exhaustive(failure);
  }
}

function exhaustive(failure: never): never {
  throw new Error(`unhandled operation failure: ${JSON.stringify(failure)}`);
}

/** Anything that reaches the top of a handler. */
export function problemForUnknown(error: unknown): Problem {
  if (error instanceof OperationError) return problemForOperationError(error);

  if (error instanceof DocumentMigrationError) {
    // A document this build cannot read (ADR-0028). 500 rather than 4xx: the request was fine, the
    // store holds something this binary should not guess at, and upgrading is the fix.
    return problem(500, 'unreadable-document', error.message, { detail: error.failure });
  }

  // Deliberately opaque. A stack trace or a store path in a response body would leak host detail
  // for no benefit (ADR-0001, ADR-0029) — the log is where the detail goes.
  return problem(500, 'internal', 'something went wrong handling that request');
}
