import { MUSIC_FONT_NAMES } from '@sibei/engrave';
import type { MusicFontName } from '@sibei/engrave';
import { PAPER_SIZES } from '@sibei/layout';
import type { Paper } from '@sibei/layout';
import type { Id, Score } from '@sibei/model';

/**
 * The UI's whole relationship with the server: an HTTP client of `/v1/` (ADR-0002). It holds no
 * store, and in this slice it does not write — every request below is a GET.
 *
 * **Same-origin, always.** The path is relative, so the browser never makes a cross-origin
 * request and the API never has to send a CORS header to satisfy one. In development the Vite
 * server proxies `/v1` to the API; see `vite.config.ts` for why that is the design and not a
 * workaround.
 */

const V1 = '/v1';

/**
 * One row of the library, as `GET /v1/scores` serves it.
 *
 * Declared here rather than imported from `@sibei/api`, which is where the server's own
 * `ScoreListing` lives: that package holds the store and the SQLite adapter, and a browser
 * bundle has no business resolving it even for a type. This is the **wire** shape, and the API
 * test is what pins the two together.
 */
export interface ScoreListing {
  id: Id;
  title: string;
  composer: string;
  /** Compact form — `Db`, `F#m`, `C`. See `formatKeySignature`. */
  key: string;
  version: number;
  updatedAt: string;
}

/** `GET /v1/scores/:id`: the document, plus the row state around it. */
export interface ScoreRecord {
  score: Score;
  /** Optimistic concurrency (ADR-0003) — not the document's `schemaVersion`, which is its shape. */
  version: number;
  updatedAt: string;
}

/**
 * Every error body the API emits is `{error: {kind, message, detail}}` (ADR-0008), so the client
 * carries the structured half through rather than flattening it to a sentence. Nothing in this
 * slice branches on `detail` yet — editing is V4c — but throwing it away here is how a later
 * card ends up parsing prose.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly kind: string;
  readonly detail: unknown;

  constructor(status: number, kind: string, message: string, detail: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    this.detail = detail;
  }
}

/** The server could not be reached at all — almost always "it is not running". */
export class OfflineError extends Error {
  constructor(cause: unknown) {
    super('nothing answered at /v1/. The API is probably not running.');
    this.name = 'OfflineError';
    this.cause = cause;
  }
}

export async function listScores(): Promise<ScoreListing[]> {
  const body = await getJson<{ scores: ScoreListing[] }>(`${V1}/scores`);
  return body.scores;
}

export async function getScore(id: Id): Promise<ScoreRecord> {
  return await getJson<ScoreRecord>(`${V1}/scores/${encodeURIComponent(id)}`);
}

export interface ExportChoice {
  paper: Paper;
  font: MusicFontName;
}

/**
 * The export route for a chart, with the reader's current choices in it.
 *
 * The face and the paper are render-time arguments (ADR-0030, Q38) and the server puts both in
 * the cache key, so the same two switches drive the sheet on screen and the bytes that come back
 * from here. That is the point of showing this string in the rail: the page you are looking at
 * and the file you are about to download are one choice, not two settings.
 */
export function exportUrl(id: Id, choice: ExportChoice): string {
  const query = new URLSearchParams({ format: 'pdf', paper: choice.paper, font: choice.font });
  return `${V1}/scores/${encodeURIComponent(id)}/export?${query.toString()}`;
}

/** The route without an id, which is what the rail prints. A concrete id wraps the column. */
export function exportRoute(choice: ExportChoice): { path: string; query: string } {
  return {
    path: `GET ${V1}/scores/:id/export`,
    query: `?format=pdf&paper=${choice.paper}&font=${choice.font}`,
  };
}

/**
 * The supported lists, **derived from the packages that own them** rather than restated — the
 * same rule the export route follows for the values it will accept. A face or a paper added
 * downstream shows up as a switch here without anyone remembering to add one.
 */
export const PAPERS = Object.keys(PAPER_SIZES) as readonly Paper[];
export const FONTS = MUSIC_FONT_NAMES;

async function getJson<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { accept: 'application/json' } });
  } catch (cause) {
    throw new OfflineError(cause);
  }

  if (!response.ok) throw await failureFrom(response);
  return (await response.json()) as T;
}

/**
 * An `ApiError` when the API answered, an `OfflineError` when something else did.
 *
 * The distinction is worth this much care because it is the first thing a reader needs and the
 * easiest thing to get backwards. Stopping the server does **not** produce a network error here:
 * requests go through the dev server's proxy (see `vite.config.ts`), and a proxy with nothing to
 * proxy to answers **500 with an empty body**. Reported as "the server refused that" it would be
 * the wrong sentence next to the wrong command — the same class of failure as the export route
 * quietly substituting A4 for a paper it does not know.
 *
 * The rule is structural rather than a status list: every error the API emits carries
 * `{error: {kind, message, detail}}` (ADR-0008), so a 5xx *without* that envelope did not come
 * from the API. A 4xx is left alone, because those are answers.
 */
interface ErrorBody {
  error?: { kind?: string; message?: string; detail?: unknown };
}

async function failureFrom(response: Response): Promise<ApiError | OfflineError> {
  let body: ErrorBody | null = null;
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    body = null;
  }

  const envelope = body?.error;
  if (envelope === undefined) {
    if (response.status >= 500) return new OfflineError(`status ${response.status}`);
    return new ApiError(response.status, 'unknown', `the server answered ${response.status}`, null);
  }

  return new ApiError(
    response.status,
    envelope.kind ?? 'unknown',
    envelope.message ?? `the server answered ${response.status}`,
    envelope.detail,
  );
}
