import { NOTE_EVENTS_SUPPORTED_INSTRUMENTS, NoteEventsError, parseNoteEvents } from '@sibei/model';
import type { NoteEvents } from '@sibei/model';

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

/** Why a NoteEvents upload was refused. Each is its own server error kind. */
export type NoteEventsRejection = 'malformed' | 'unsupported-version' | 'unsupported-instrument';

export type NoteEventsCheck =
  | { ok: true; document: NoteEvents }
  | { ok: false; reason: NoteEventsRejection; message: string; problems: string[] };

export function validateNoteEventsUpload(bytes: Buffer): NoteEventsCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return refuse('malformed', 'the upload is not valid JSON', ['document is not valid JSON']);
  }
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
    const supported = NOTE_EVENTS_SUPPORTED_INSTRUMENTS.join(' and ');
    return refuse(
      'unsupported-instrument',
      `instrument ${JSON.stringify(document.instrument)} cannot be notated yet; only ${supported} import to a single melody staff`,
      [`instrument is ${document.instrument}`],
    );
  }
  return { ok: true, document };
}

function refuse(reason: NoteEventsRejection, message: string, problems: string[]): NoteEventsCheck {
  return { ok: false, reason, message, problems };
}
