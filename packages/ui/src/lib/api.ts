import { MUSIC_FONT_NAMES } from '@sibei/engrave';
import type { MusicFontName } from '@sibei/engrave';
import { PAPER_SIZES } from '@sibei/layout';
import type { Paper } from '@sibei/layout';
import type {
  AccidentalDisplay,
  Duration,
  EndBarline,
  EndingRole,
  Id,
  KeySignature,
  Score,
  StartBarline,
} from '@sibei/model';

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
 * carries the structured half through rather than flattening it to a sentence. `currentVersion`
 * is promoted the same way the API promotes it (`packages/api/src/http/problems.ts`): present
 * only on a 409 from a stale write, and it is what to re-read at (ADR-0003).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly kind: string;
  readonly detail: unknown;
  readonly currentVersion: number | undefined;

  constructor(status: number, kind: string, message: string, detail: unknown, currentVersion?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    this.detail = detail;
    this.currentVersion = currentVersion;
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

/**
 * Library lifecycle (V8c). Delete destroys a chart and its log (ADR-0003) — irreversible, which is
 * why the library asks first. Duplicate copies a chart to a new one with a fresh history; the server
 * mints the new id, and the caller re-reads the list rather than trusting the returned shape, the
 * same discipline as an edit.
 */
export async function deleteScore(id: Id): Promise<void> {
  await sendNoBody('DELETE', `${V1}/scores/${encodeURIComponent(id)}`);
}

export interface DuplicateResult {
  scoreId: Id;
  version: number;
  sourceId: Id;
}

export async function duplicateScore(id: Id): Promise<DuplicateResult> {
  return await postJson<DuplicateResult>(`${V1}/scores/${encodeURIComponent(id)}/duplicate`, {});
}

/**
 * The write side (V4c). Declared here rather than imported from `@sibei/api`'s
 * `packages/api/src/ops/operations.ts` — the same reason `ScoreListing` and `ScoreRecord` above
 * are the wire shape rather than an import: `@sibei/api` also holds the store and the applier,
 * and a browser bundle has no business resolving that package even for a type
 * (`tests/arch/framework-free.test.ts` bans the string `@sibei/api` from this package outright).
 * `Duration` and `AccidentalDisplay` come from `@sibei/model` instead, which the UI already
 * depends on and which is framework-free by the same rule.
 *
 * **Deliberately only the verbs the inspector needs.** V4c added the note and rest edits; V5e
 * adds `chord.set` and `chord.rm` for the chord inspector; V6e `transpose`; V7c the structure
 * verbs the Structure panel drives — `section.set`/`section.rm`, `barline.set`,
 * `ending.set`/`ending.rm`. `note.add` on its own, `score.create` and `meta.set` exist on the
 * server and have no UI control yet — that is booked debt (Q79), not a gap this file is meant to
 * close.
 */
export interface NoteSetPayload {
  pitch?: string;
  duration?: Duration;
  accidental?: AccidentalDisplay;
  /** Pin the spelling so it survives a transpose (ADR-0017). V6e. */
  spellingPinned?: boolean;
}

export interface RestAddPayload {
  duration: Duration;
}

export interface ChordSetPayload {
  text: string;
  /** Pin the root's spelling so it survives a transpose (ADR-0017). V6e. */
  spellingPinned?: boolean;
}

/** The concert key to transpose the whole chart into — a mutation, logged and undoable (ADR-0016). */
export interface TransposePayload {
  to: KeySignature;
}

/** Structure verbs (V7c). All target a whole-bar address (`bar7`), the way the CLI's do. */
export interface SectionSetPayload {
  /** Null clears the rehearsal letter; omitted keeps it on an upsert. */
  letter?: string | null;
  name?: string | null;
}

export interface BarlineSetPayload {
  start?: StartBarline;
  end?: EndBarline;
}

export interface EndingSetPayload {
  numbers: number[];
  role: EndingRole;
}

export type Operation =
  | { type: 'note.set'; target: string; payload: NoteSetPayload }
  | { type: 'rest.add'; target: string; payload: RestAddPayload }
  | { type: 'rest.rm'; target: string }
  | { type: 'chord.set'; target: string; payload: ChordSetPayload }
  | { type: 'chord.rm'; target: string }
  | { type: 'transpose'; payload: TransposePayload }
  | { type: 'section.set'; target: string; payload: SectionSetPayload }
  | { type: 'section.rm'; target: string }
  | { type: 'barline.set'; target: string; payload: BarlineSetPayload }
  | { type: 'ending.set'; target: string; payload: EndingSetPayload }
  | { type: 'ending.rm'; target: string };

export interface Batch {
  operations: readonly Operation[];
  expectedVersion: number;
}

/**
 * `POST /v1/scores/:id/ops`. The response body (`ApplyResult`) is deliberately not read for its
 * content — same reasoning as the SSE event payload (`changed[]` names ids, never values) — so
 * the caller's job after this resolves is to re-`getScore`, never to trust what came back here.
 */
export async function submitOps(id: Id, batch: Batch): Promise<void> {
  await postJson(`${V1}/scores/${encodeURIComponent(id)}/ops`, batch);
}

/**
 * The result of an undo or a redo (V8a, ADR-0003). Unlike an edit, the caller does read one field
 * of the response — `moved` — so ctrl-Z at the undo floor is a quiet no-op rather than an apparent
 * failure. Everything else the caller learns by re-`getScore`, the same discipline as `submitOps`:
 * the version and `moved` are enough to decide whether to repaint, never the content.
 */
export interface MoveResult {
  version: number;
  moved: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * `POST /v1/scores/:id/undo` and `…/redo`. Both carry `expectedVersion` for the same reason an edit
 * does (ADR-0003): an undo reverts the version the reader is looking at, and a stale one is a 409 it
 * recovers from by reloading — exactly the path `runOps` takes.
 */
export async function undoScore(id: Id, expectedVersion: number): Promise<MoveResult> {
  return await postJson<MoveResult>(`${V1}/scores/${encodeURIComponent(id)}/undo`, { expectedVersion });
}

export async function redoScore(id: Id, expectedVersion: number): Promise<MoveResult> {
  return await postJson<MoveResult>(`${V1}/scores/${encodeURIComponent(id)}/redo`, { expectedVersion });
}

/**
 * The instrument a part is written for (V6e, ADR-0016). Declared here as the **wire** value the
 * export route accepts, for the same reason `ScoreListing` is: `@sibei/api` owns the real
 * `PART_INSTRUMENTS`, and a browser bundle may not resolve that package (`tests/arch`). A name this
 * list carries that the server does not is a 422, the same no-fallback bargain the paper and face
 * make.
 */
export type ExportInstrument =
  | 'concert'
  | 'bb-trumpet'
  | 'bb-tenor'
  | 'eb-alto'
  | 'eb-bari'
  | 'f-horn';

export interface InstrumentOption {
  value: ExportInstrument;
  label: string;
  /** The written transposition, for the reader who does not carry the intervals in their head. */
  hint: string;
}

/** `concert` first — the identity, and the default. The five transposing parts follow (ADR-0016). */
export const INSTRUMENTS: readonly InstrumentOption[] = [
  { value: 'concert', label: 'Concert score', hint: 'as stored' },
  { value: 'bb-trumpet', label: 'B♭ Trumpet', hint: 'written a major 2nd up' },
  { value: 'bb-tenor', label: 'B♭ Tenor', hint: 'written a major 9th up' },
  { value: 'eb-alto', label: 'E♭ Alto', hint: 'written a major 6th up' },
  { value: 'eb-bari', label: 'E♭ Bari', hint: 'written a major 13th up' },
  { value: 'f-horn', label: 'F Horn', hint: 'written a perfect 5th up' },
];

/**
 * The export format (V8e). The **wire** values the export route accepts — `@sibei/api` owns
 * `EXPORT_FORMATS`, and this bundle may not resolve it (`tests/arch`), so it is restated here the
 * way `ExportInstrument` is. An unknown value is a 422, the same no-fallback bargain paper makes.
 * MusicXML is a codec at the edges (ADR-0004), not a render, so it ignores paper and face.
 */
export type ExportFormat = 'pdf' | 'musicxml';

export interface FormatOption {
  value: ExportFormat;
  label: string;
}

/** `pdf` first — the default, and what the sheet on screen is. */
export const FORMATS: readonly FormatOption[] = [
  { value: 'pdf', label: 'PDF' },
  { value: 'musicxml', label: 'MusicXML' },
];

export interface ExportChoice {
  format: ExportFormat;
  paper: Paper;
  font: MusicFontName;
  instrument: ExportInstrument;
}

/** The instrument goes on the query only when it is not the default, the way the CLI sends it. */
function instrumentQuery(instrument: ExportInstrument): string {
  return instrument === 'concert' ? '' : `&instrument=${instrument}`;
}

/**
 * The export route for a chart, with the reader's current choices in it.
 *
 * The face and the paper are render-time arguments (ADR-0030, Q38) and the server puts them in
 * the cache key, so the same switches drive the sheet on screen and the bytes that come back from
 * here. The instrument is a third such argument (ADR-0016): a part is a render-time view, so it
 * belongs beside them and not on a write. That is the point of showing this string in the rail:
 * the page you are looking at and the file you are about to download are one choice, not two.
 */
export function exportUrl(id: Id, choice: ExportChoice): string {
  const base = new URLSearchParams({ format: choice.format, paper: choice.paper, font: choice.font });
  return `${V1}/scores/${encodeURIComponent(id)}/export?${base.toString()}${instrumentQuery(choice.instrument)}`;
}

/** The route without an id, which is what the rail prints. A concrete id wraps the column. */
export function exportRoute(choice: ExportChoice): { path: string; query: string } {
  return {
    path: `GET ${V1}/scores/:id/export`,
    query: `?format=${choice.format}&paper=${choice.paper}&font=${choice.font}${instrumentQuery(choice.instrument)}`,
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

/** A request with no request or response body worth parsing — DELETE (V8c), which answers 204. */
async function sendNoBody(method: string, path: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(path, { method, headers: { accept: 'application/json' } });
  } catch (cause) {
    throw new OfflineError(cause);
  }
  if (!response.ok) throw await failureFrom(response);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
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
  error?: { kind?: string; message?: string; detail?: unknown; currentVersion?: number };
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
    envelope.currentVersion,
  );
}
