import { MAX_STEMS, NOTE_EVENTS_SUPPORTED_INSTRUMENTS, NoteEventsError, checkStems, mapNoteEventsToScore, mapStemsToScore, parseNoteEvents } from '@sibei/model';
import type { NoteEvents, NoteEventsDraft, NoteEventsMapOptions } from '@sibei/model';

/**
 * The NoteEvents upload boundary (ADR-0040 #7), the sibling of `upload.ts`'s image decode (ADR-0029).
 *
 * A NoteEvents document is validated here, before any job exists: parsed as JSON, checked against the
 * v1 contract (`parseNoteEvents`), and checked for an instrument this build can notate. A refusal is
 * **distinct and non-retryable** — the same bytes would be refused again — so it never becomes a job;
 * the route answers 422 with the reason, and nothing is stored.
 */

/**
 * The marker a NoteEvents job carries in `ImportJob.engine`. The worker owns the set of OMR engine
 * names and nothing on the API side interprets them (ADR-0005), so a source that needs no worker at
 * all can reuse the one durable column that already tells the runner what to do with a job — no schema
 * change. The runner reads it to take the pure map path instead of calling the OMR worker, and the
 * source/reparse reads treat such a job as having no scanned image.
 */
export const NOTE_EVENTS_SOURCE = 'note-events';

/** The MIDI pitches a hand split may pivot on: the piano's own range. */
export const MIN_SPLIT_POINT = 21;
export const MAX_SPLIT_POINT = 108;

/**
 * The marker with its options (SIB2-244): a piano import's `splitPoint` is kept on the job so a re-draft or a retry
 * reproduces the draft the user asked for. It rides on the same opaque `engine` column (no schema change, ADR-0006's
 * adapters untouched): `note-events` alone is the default, `note-events;split=62` pivots the hands on D#4.
 */
export function noteEventsEngine(splitPoint?: number): string {
  return splitPoint === undefined ? NOTE_EVENTS_SOURCE : `${NOTE_EVENTS_SOURCE};split=${splitPoint}`;
}

/** Whether a job's `engine` marks a NoteEvents job, with or without options. */
export function isNoteEventsEngine(engine: string | null): boolean {
  return engine === NOTE_EVENTS_SOURCE || (engine !== null && engine.startsWith(`${NOTE_EVENTS_SOURCE};`));
}

/** The split point a NoteEvents job was asked for, or undefined for the default. */
export function splitPointOfEngine(engine: string | null): number | undefined {
  const match = engine === null ? null : /;split=(\d+)$/.exec(engine);
  return match === null ? undefined : Number(match[1]);
}

/** A `splitPoint` from a request: undefined when absent, a number when it is a MIDI pitch in the piano's range, else null. */
export function validSplitPoint(raw: unknown): number | undefined | null {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = typeof raw === 'string' ? (/^\d+$/.test(raw) ? Number(raw) : Number.NaN) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_SPLIT_POINT || value > MAX_SPLIT_POINT) return null;
  return value;
}

/** Why a NoteEvents upload was refused. Each is its own server error kind. */
export type NoteEventsRejection = 'malformed' | 'unsupported-version' | 'unsupported-instrument';

export type NoteEventsCheck =
  | {
      ok: true;
      /** The first (or only) document. */
      document: NoteEvents;
      /** Every document: one for the v1 case, one per stem for a set (SIB2-147). */
      documents: NoteEvents[];
      /** What to store as the job's source: the upload's own bytes for one document, `{ "stems": [...] }` for a set. */
      bytes: Buffer;
    }
  | { ok: false; reason: NoteEventsRejection; message: string; problems: string[] };

export function validateNoteEventsUpload(bytes: Buffer): NoteEventsCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return refuse('malformed', 'the upload is not valid JSON', ['document is not valid JSON']);
  }
  return checkNoteEventsInput(raw, bytes);
}

/**
 * The stems a result or upload names, or `null` for the v1 case of one document. A set is `{ "stems": [...] }` (the
 * audio worker's `complete`, and what a set is stored as) or a bare JSON array (an upload). A NoteEvents document has
 * no `stems` key, so the two shapes never collide (ADR-0034 amendment, SIB2-147).
 */
function stemsOf(raw: unknown): unknown[] | 'not-an-array' | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object' && raw !== null && 'stems' in raw) {
    const stems = (raw as { stems: unknown }).stems;
    return Array.isArray(stems) ? stems : 'not-an-array';
  }
  return null;
}

/**
 * Check a whole NoteEvents input, one document or several stems. A one-element set is exactly the single document
 * (same refusals, same draft); two or more must come from one recording (`checkStems`), each stem must be valid v1, and
 * a stem with an instrument we cannot notate is kept (as a melody staff with a warning) rather than refused, since
 * refusing it would discard the band (ADR-0040 amendment). A refusal names the stem index and nothing is stored.
 */
export function checkNoteEventsInput(raw: unknown, original?: Buffer): NoteEventsCheck {
  const stems = stemsOf(raw);
  if (stems === null) {
    const single = checkNoteEvents(raw);
    return single.ok ? { ...single, documents: [single.document], bytes: original ?? Buffer.from(JSON.stringify(raw)) } : single;
  }
  if (stems === 'not-an-array') return refuse('malformed', 'stems is not an array', ['stems is not an array']);
  if (stems.length === 1) {
    const only = checkNoteEvents(stems[0]);
    return only.ok ? { ...only, documents: [only.document], bytes: Buffer.from(JSON.stringify(stems[0])) } : only;
  }
  if (stems.length === 0 || stems.length > MAX_STEMS) {
    const problem = stems.length === 0 ? 'stems is empty' : `stems has ${stems.length} entries; at most ${MAX_STEMS} are read`;
    return refuse('malformed', problem, [problem]);
  }
  const documents: NoteEvents[] = [];
  const problems: string[] = [];
  let reason: NoteEventsRejection = 'malformed';
  stems.forEach((stem, index) => {
    try {
      documents.push(parseNoteEvents(stem));
    } catch (error) {
      if (!(error instanceof NoteEventsError)) throw error;
      if (error.kind === 'unsupported-version') reason = 'unsupported-version';
      problems.push(...error.problems.map((p) => `stems[${index}]: ${p}`));
    }
  });
  if (problems.length === 0) problems.push(...checkStems(documents));
  if (problems.length > 0) return refuse(reason, `NoteEvents stems refused (${reason}): ${problems.join('; ')}`, problems);
  return { ok: true, document: documents[0]!, documents, bytes: Buffer.from(JSON.stringify({ stems })) };
}

/** Map a checked input (one document or several stems) to a draft: the single mapper, or the stem combiner. */
export function mapNoteEventsDocuments(documents: readonly NoteEvents[], options: NoteEventsMapOptions): NoteEventsDraft {
  return documents.length === 1 ? mapNoteEventsToScore(documents[0]!, options) : mapStemsToScore(documents, options);
}

/** The same checks on one already-parsed document. */
export function checkNoteEvents(raw: unknown): NoteEventsCheck {
  let document: NoteEvents;
  try {
    document = parseNoteEvents(raw);
  } catch (error) {
    if (error instanceof NoteEventsError) {
      return refuse(error.kind === 'unsupported-version' ? 'unsupported-version' : 'malformed', error.message, [...error.problems]);
    }
    throw error;
  }
  if (!NOTE_EVENTS_SUPPORTED_INSTRUMENTS.includes(document.instrument)) {
    const supported = NOTE_EVENTS_SUPPORTED_INSTRUMENTS.join(', ');
    return refuse(
      'unsupported-instrument',
      `instrument ${JSON.stringify(document.instrument)} cannot be notated yet; only ${supported} can be imported`,
      [`instrument is ${document.instrument}`],
    );
  }
  return { ok: true, document, documents: [document], bytes: Buffer.alloc(0) };
}

function refuse(reason: NoteEventsRejection, message: string, problems: string[]): NoteEventsCheck {
  return { ok: false, reason, message, problems };
}
