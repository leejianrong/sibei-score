import { OperationError } from './errors.js';
import type { Operation, OperationType } from './operations.js';

/**
 * The payload fields each operation knows (SIB2-188).
 *
 * A field the applier does not read used to be accepted and dropped without a word — a `tuplet` on
 * `note.add` "worked" and did nothing, so a caller could not tell its input had no effect. A *new*
 * write that names one is now refused as a validation failure that names the field.
 *
 * **Only new writes are checked** (`createApplier.apply`), never replay: ADR-0028 says an old
 * operation shape stays readable forever because undo replays the log, and a log written before this
 * check may hold an op with a field we now call unknown. `replay` and `resolveLog` do not call this,
 * so every stored log still replays exactly. Recorded fields (`id`, `bars`) are in the lists because
 * the applier writes them back into the payload and a client may echo them.
 *
 * Adding a payload field means adding it here too, or a new write that uses it is refused.
 */
const KNOWN_FIELDS: Record<OperationType, readonly string[]> = {
  'score.create': ['id', 'title', 'composer', 'style', 'key', 'time', 'barCount', 'pickup', 'bars'],
  'score.import': ['document'],
  'meta.set': ['title', 'composer', 'style', 'key', 'time', 'footer', 'footerPages', 'signaturePolicy', 'chordStyle', 'barsPerSystem', 'tempo'],
  'note.add': ['pitch', 'duration', 'accidental', 'tie', 'spellingPinned', 'id'],
  'note.set': ['pitch', 'duration', 'accidental', 'tie', 'spellingPinned'],
  'note.rm': [],
  'rest.add': ['duration', 'id'],
  'rest.rm': [],
  'chord.set': ['text', 'spellingPinned', 'id'],
  'chord.rm': [],
  'text.set': ['text', 'id'],
  'text.rm': [],
  transpose: ['to'],
  'section.set': ['letter', 'name', 'id'],
  'section.rm': [],
  'barline.set': ['start', 'end'],
  'ending.set': ['numbers', 'role'],
  'ending.rm': [],
  'tuplet.set': ['actual', 'normal', 'count', 'id'],
  'tuplet.rm': [],
  'break.set': ['kind'],
  'break.rm': [],
  'slur.set': ['to', 'placement', 'id'],
  'slur.rm': [],
  'ottava.set': ['to', 'shift', 'id'],
  'ottava.rm': [],
  'bar.add': ['count', 'ids'],
  'bar.rm': [],
};

/** Throws a validation failure naming the first payload field the operation does not know. */
export function rejectUnknownFields(operation: Operation, index?: number): void {
  const known = KNOWN_FIELDS[operation.type];
  // An unknown type is the applier's own refusal; do not pre-empt its message.
  if (known === undefined) return;
  const payload = (operation as { payload?: unknown }).payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
  for (const field of Object.keys(payload)) {
    if (!known.includes(field)) {
      throw new OperationError(
        {
          kind: 'validation',
          detail: `${operation.type} has no field ${JSON.stringify(field)}; it takes ${
            known.length === 0 ? 'no fields' : known.join(', ')
          }`,
        },
        index,
      );
    }
  }
}
