/**
 * NoteEvents v1 — the audio engine's output contract, as we read it (ADR-0040).
 *
 * The audio repo (music-audio-transcriber, its ADR-0002) owns the JSON Schema; we do not edit it. This
 * file is our model-owned TypeScript type and validator for it, the way `omr.ts` is for the OMR worker,
 * so the two repos cannot drift silently: the fixtures under `tests/fixtures/note-events/` are the
 * cross-repo test. Field names are the wire's (snake_case) on purpose — this is raw input, not the
 * score model. Times are **seconds**, never beats; turning them into bars is `note-events-quantize.ts`.
 *
 * Framework-free and Node-free plain TypeScript, like the rest of `model`.
 */

/** The only major we read. The contract bumps it for any change (ADR-0040 #2). */
export const NOTE_EVENTS_SCHEMA_VERSION = 1;

export type NoteEventsInstrument = 'voice' | 'bass' | 'piano' | 'drums' | 'guitar' | 'other';

/**
 * The instruments this repo can notate: a melody staff for `voice` and `bass` (ADR-0021, ADR-0040 #3), and a percussion
 * staff for `drums` (ADR-0041 slice 6, `note-events-drums.ts`). Piano, guitar and `other` are not yet.
 */
export const NOTE_EVENTS_SUPPORTED_INSTRUMENTS: readonly NoteEventsInstrument[] = ['voice', 'bass', 'drums'];

export interface NoteEventsBeat {
  t_s: number;
  /** Absent or null when the tracker did not say. */
  is_downbeat?: boolean | null;
}

export interface NoteEventsNote {
  id: string;
  onset_s: number;
  offset_s: number;
  /** MIDI note number, 0-127. */
  pitch: number;
  /** Deviation from `pitch` in cents, -50..50. */
  cents?: number | null;
  velocity?: number | null;
  /** 0-1. */
  confidence: number;
  drum_class?: string | null;
}

export interface NoteEventsWarning {
  code: string;
  message: string;
  t_s?: number | null;
}

export interface NoteEvents {
  schema_version: 1;
  source: { sha256: string; duration_s: number };
  instrument: NoteEventsInstrument;
  producer: { model_id: string; model_version: string; stage: 'transcribe' };
  beats: NoteEventsBeat[];
  notes: NoteEventsNote[];
  warnings: NoteEventsWarning[];
}

/**
 * Why a document was refused. `unsupported-version` is its own kind: it means the audio engine is
 * ahead of us, which is a different fix from a corrupt file (ADR-0040 #2).
 */
export type NoteEventsErrorKind = 'malformed' | 'unsupported-version';

/** Thrown by {@link parseNoteEvents}. Every problem names its field path, e.g. `notes[3].onset_s`. */
export class NoteEventsError extends Error {
  readonly kind: NoteEventsErrorKind;
  readonly problems: readonly string[];
  constructor(kind: NoteEventsErrorKind, problems: readonly string[]) {
    super(`NoteEvents document refused (${kind}): ${problems.join('; ')}`);
    this.name = 'NoteEventsError';
    this.kind = kind;
    this.problems = problems;
  }
}

const INSTRUMENTS: readonly string[] = ['voice', 'bass', 'piano', 'drums', 'guitar', 'other'];
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Validate an unknown value as NoteEvents v1, returning it typed with `beats`, `notes` and `warnings`
 * defaulted to empty (the schema leaves them optional). Strict where the schema is: unknown keys are
 * errors, ranges are checked. An unknown `schema_version` throws `unsupported-version` before any
 * other check, since the rest of the document cannot be judged against a schema we do not have.
 */
export function parseNoteEvents(raw: unknown): NoteEvents {
  if (!isObject(raw)) throw new NoteEventsError('malformed', [`document is not an object: ${describe(raw)}`]);

  // The schema defaults the version to 1, so an absent one is read as 1.
  const version = raw.schema_version === undefined ? NOTE_EVENTS_SCHEMA_VERSION : raw.schema_version;
  if (version !== NOTE_EVENTS_SCHEMA_VERSION) {
    throw new NoteEventsError('unsupported-version', [
      `schema_version is ${describe(version)}; this importer reads only ${NOTE_EVENTS_SCHEMA_VERSION}`,
    ]);
  }

  const p: string[] = [];
  noExtraKeys(raw, ['schema_version', 'source', 'instrument', 'producer', 'beats', 'notes', 'warnings'], '', p);

  if (!isObject(raw.source)) p.push('source is missing or not an object');
  else {
    noExtraKeys(raw.source, ['sha256', 'duration_s'], 'source', p);
    if (typeof raw.source.sha256 !== 'string' || !SHA256.test(raw.source.sha256)) {
      p.push('source.sha256 is not a 64-character lowercase hex string');
    }
    if (!isNumber(raw.source.duration_s) || raw.source.duration_s < 0) {
      p.push('source.duration_s is not a number >= 0');
    }
  }

  if (typeof raw.instrument !== 'string' || !INSTRUMENTS.includes(raw.instrument)) {
    p.push(`instrument is not one of ${INSTRUMENTS.join(', ')}: ${describe(raw.instrument)}`);
  }

  if (!isObject(raw.producer)) p.push('producer is missing or not an object');
  else {
    noExtraKeys(raw.producer, ['model_id', 'model_version', 'stage'], 'producer', p);
    if (typeof raw.producer.model_id !== 'string') p.push('producer.model_id is not a string');
    if (typeof raw.producer.model_version !== 'string') p.push('producer.model_version is not a string');
    if (raw.producer.stage !== undefined && raw.producer.stage !== 'transcribe') {
      p.push('producer.stage is not "transcribe"');
    }
  }

  const beats = checkArray(raw.beats, 'beats', p, (b, at) => {
    if (!isObject(b)) return p.push(`${at} is not an object`);
    noExtraKeys(b, ['t_s', 'is_downbeat'], at, p);
    if (!isNumber(b.t_s) || b.t_s < 0) p.push(`${at}.t_s is not a number >= 0`);
    if (b.is_downbeat != null && typeof b.is_downbeat !== 'boolean') p.push(`${at}.is_downbeat is not a boolean or null`);
  });

  const notes = checkArray(raw.notes, 'notes', p, (n, at) => {
    if (!isObject(n)) return p.push(`${at} is not an object`);
    noExtraKeys(n, ['id', 'onset_s', 'offset_s', 'pitch', 'cents', 'velocity', 'confidence', 'drum_class'], at, p);
    if (typeof n.id !== 'string') p.push(`${at}.id is not a string`);
    if (!isNumber(n.onset_s) || n.onset_s < 0) p.push(`${at}.onset_s is not a number >= 0`);
    if (!isNumber(n.offset_s)) p.push(`${at}.offset_s is not a number`);
    // The audio repo's contract (its invalid_offset_not_after_onset fixture): a note has a duration.
    else if (isNumber(n.onset_s) && n.offset_s <= n.onset_s) p.push(`${at}.offset_s is not after onset_s`);
    if (!isInt(n.pitch, 0, 127)) p.push(`${at}.pitch is not an integer in 0..127`);
    if (n.cents != null && !isInt(n.cents, -50, 50)) p.push(`${at}.cents is not an integer in -50..50`);
    if (n.velocity != null && !isInt(n.velocity, 0, 127)) p.push(`${at}.velocity is not an integer in 0..127`);
    if (!isNumber(n.confidence) || n.confidence < 0 || n.confidence > 1) p.push(`${at}.confidence is not a number in 0..1`);
    if (n.drum_class != null && typeof n.drum_class !== 'string') p.push(`${at}.drum_class is not a string or null`);
  });

  const warnings = checkArray(raw.warnings, 'warnings', p, (w, at) => {
    if (!isObject(w)) return p.push(`${at} is not an object`);
    noExtraKeys(w, ['code', 'message', 't_s'], at, p);
    if (typeof w.code !== 'string') p.push(`${at}.code is not a string`);
    if (typeof w.message !== 'string') p.push(`${at}.message is not a string`);
    if (w.t_s != null && !isNumber(w.t_s)) p.push(`${at}.t_s is not a number or null`);
  });

  if (p.length > 0) throw new NoteEventsError('malformed', p);
  return {
    ...(raw as unknown as NoteEvents),
    schema_version: NOTE_EVENTS_SCHEMA_VERSION,
    beats: beats as NoteEventsBeat[],
    notes: notes as NoteEventsNote[],
    warnings: warnings as NoteEventsWarning[],
  };
}

function checkArray(value: unknown, at: string, p: string[], each: (item: unknown, at: string) => unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    p.push(`${at} is not an array`);
    return [];
  }
  value.forEach((item, i) => each(item, `${at}[${i}]`));
  return value;
}

function noExtraKeys(o: Record<string, unknown>, allowed: readonly string[], at: string, p: string[]): void {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) p.push(`${at === '' ? '' : `${at}.`}${key} is not a field of NoteEvents v1`);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isInt(v: unknown, lo: number, hi: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
}
function describe(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean' || v === undefined) return String(v);
  return Array.isArray(v) ? 'an array' : 'an object';
}
