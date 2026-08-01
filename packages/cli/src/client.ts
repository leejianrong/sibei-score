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
  exportScore(id: string, query: ExportQuery): Promise<Download>;
  health(): Promise<{ status: string; api: string }>;
}

/**
 * The export query, as strings, straight from the command line.
 *
 * **Nothing here is validated locally**, which is the same rule the rest of this CLI follows: the
 * server owns what a paper or a face *is*, and a client that had its own opinion could disagree
 * with it (ADR-0002). An unrecognised value comes back as a 422 carrying the list of what this
 * build can produce, which is a better answer than anything the CLI could have made up.
 */
export interface ExportQuery {
  format?: string;
  paper?: string;
  font?: string;
}

/** Bytes off the wire, plus what the server called them. */
export interface Download {
  bytes: Buffer;
  /**
   * The server's own download name, out of `Content-Disposition`. A *suggestion*: it is sanitised
   * at the source, but it arrives over a socket and the CLI turns it into a path, so it is checked
   * again before anything is written (`output.ts`).
   */
  filename: string;
  contentType: string;
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
  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await fetch(`${baseUrl}${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
      });
    } catch (error) {
      // The one failure a file-editing CLI would not have had. Say what to do about it.
      throw new CliError(
        EXIT.noServer,
        'no-server',
        `cannot reach the sbscore server at ${baseUrl}. Start it with \`sbscore serve\`, or point this ` +
          `at a running one with --url or SBSCORE_URL.`,
        { detail: error instanceof Error ? error.message : undefined },
      );
    }
  }

  /**
   * A failure body into a `CliError`. Shared by the JSON calls and the byte-returning one, so an
   * export that asks for a paper this build cannot produce reports exactly what a bad address
   * reports — the server's own words and the server's own `detail`.
   */
  function fail(status: number, text: string): never {
    const error = (safeParse(text) as { error?: ServerError }).error;
    if (error === undefined) {
      throw new CliError(EXIT.usage, 'unknown', `the server answered ${status}`);
    }
    // The server's own message, verbatim. Both surfaces print the same words because neither
    // rewrites them (PLAN.md).
    throw new CliError(exitCodeForKind(error.kind), error.kind, error.message, {
      detail: error.detail,
      ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }),
      ...(error.operation === undefined ? {} : { operation: error.operation }),
    });
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await send(method, path, body);
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    if (!response.ok) fail(response.status, text);
    return (text === '' ? {} : safeParse(text)) as T;
  }

  /**
   * The one call that does not come back as JSON. A PDF is bytes, so it is read as bytes and never
   * decoded — an artefact that went through `JSON.parse` on its way past would be a corrupted one.
   * A failure is still JSON, which is why the not-ok branch comes first.
   */
  async function download(path: string): Promise<Download> {
    const response = await send('GET', path);
    if (!response.ok) fail(response.status, await response.text());
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      filename: filenameFrom(response.headers.get('content-disposition')),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
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
    exportScore: (id, query) => {
      // Only what was asked for. Restating the server's defaults here would be two places that
      // have to agree about what a default is, and the query is the export cache's key (Q81).
      const search = new URLSearchParams(
        Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      const suffix = search.size === 0 ? '' : `?${search.toString()}`;
      return download(`/v1/scores/${encodeURIComponent(id)}/export${suffix}`);
    },
  };
}

/** `attachment; filename="Body and Soul.pdf"` -> `Body and Soul.pdf`, or nothing at all. */
function filenameFrom(header: string | null): string {
  return /filename="([^"]*)"/.exec(header ?? '')?.[1] ?? '';
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
