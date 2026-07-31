import type { Operation } from '@sibei/api';
import type { Score } from '@sibei/model';
import { EXIT, exitCodeForKind } from './exit-codes.js';
import type { ExitCode } from './exit-codes.js';

/**
 * The HTTP client.
 *
 * The CLI is a host-side program talking HTTP to the API (ADR-0002) — **not a second write path**,
 * which is the entire point. It needs an HTTP client and it needs to handle a server that is not
 * running, both of which a file-editing CLI would not have needed. ADR-0002 names that as a real cost
 * of the decision, so it is handled here properly rather than as an afterthought.
 */

export const DEFAULT_BASE_URL = 'http://127.0.0.1:4321';

/**
 * A failure the CLI can report and exit on. Never a stack trace.
 *
 * The extra fields are flat rather than nested. The first version wrapped the server's whole error
 * object as `detail`, so `--json` came back with `detail.detail.detail` and an agent had to dig three
 * levels for the onsets — which defeats the point of structured errors (ADR-0008).
 */
export class CliError extends Error {
  readonly code: ExitCode;
  readonly kind: string;
  readonly detail: unknown;
  /** On a stale write: the version to re-read at (ADR-0003). */
  readonly currentVersion: number | undefined;
  /** 1-based position in a batch, when one operation of several was at fault. */
  readonly operation: number | undefined;

  constructor(
    code: ExitCode,
    kind: string,
    message: string,
    extra: { detail?: unknown; currentVersion?: number; operation?: number } = {},
  ) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.kind = kind;
    this.detail = extra.detail;
    this.currentVersion = extra.currentVersion;
    this.operation = extra.operation;
  }
}

export interface ServerError {
  kind: string;
  message: string;
  detail?: unknown;
  currentVersion?: number;
  operation?: number;
}

export interface Client {
  list(): Promise<{ scores: ScoreListingWire[] }>;
  read(id: string): Promise<{ score: Score; version: number; updatedAt: string }>;
  remove(id: string): Promise<void>;
  create(operations: Operation[]): Promise<ApplyWire>;
  apply(id: string, operations: Operation[], expectedVersion?: number): Promise<ApplyWire>;
  health(): Promise<{ status: string; api: string }>;
}

export interface ScoreListingWire {
  id: string;
  title: string;
  composer: string;
  key: string;
  version: number;
  updatedAt: string;
}

export interface ApplyWire {
  scoreId: string;
  version: number;
  changed: string[];
  applied: Operation[];
}

export function createClient(baseUrl: string = DEFAULT_BASE_URL): Client {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
      });
    } catch (error) {
      // The one failure a file-editing CLI would not have had. Say what to do about it.
      throw new CliError(
        EXIT.noServer,
        'no-server',
        `cannot reach the sibei server at ${baseUrl}. Start it with \`sibei serve\`, or point this ` +
          `at a running one with --url or SIBEI_URL.`,
        { detail: error instanceof Error ? error.message : undefined },
      );
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    const parsed: unknown = text === '' ? {} : safeParse(text);

    if (!response.ok) {
      const error = (parsed as { error?: ServerError }).error;
      if (error === undefined) {
        throw new CliError(EXIT.usage, 'unknown', `the server answered ${response.status}`);
      }
      // The server's own message, verbatim. Both surfaces print the same words because neither
      // rewrites them (PLAN.md).
      throw new CliError(exitCodeForKind(error.kind), error.kind, error.message, {
        detail: error.detail,
        ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }),
        ...(error.operation === undefined ? {} : { operation: error.operation }),
      });
    }
    return parsed as T;
  }

  return {
    health: () => call('GET', '/v1/health'),
    list: () => call('GET', '/v1/scores'),
    read: (id) => call('GET', `/v1/scores/${encodeURIComponent(id)}`),
    remove: (id) => call('DELETE', `/v1/scores/${encodeURIComponent(id)}`),
    create: (operations) => call('POST', '/v1/scores', { operations }),
    apply: (id, operations, expectedVersion) =>
      call('POST', `/v1/scores/${encodeURIComponent(id)}/ops`, {
        operations,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      }),
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
