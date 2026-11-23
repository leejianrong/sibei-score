import { allStaves, barView, voiceIndexes } from './staves.js';
import { barCapacity } from './duration.js';
import type { Bar, BarItem, Ending, EndBarline, Id, KeySignature, Score, Spanner, StartBarline, TimeSignature, Tuplet } from './score.js';

/**
 * A **clip**: a copied span of one staff (SIB2-279), as plain data. It is what `sbscore range copy` prints, what the
 * browser keeps in its clipboard (and writes to the system clipboard as JSON), and the payload of the `range.paste` op, so
 * a paste replays exactly from the log (ADR-0003) and an agent can paste with a `batch`.
 *
 * Everything in it is positioned **relative to the span's start**, in ticks, so it can land at any bar and beat. Ids inside
 * are clip-local (the source's ids, kept only so a tuplet's members and a slur's ends can find each other); a paste gives
 * every pasted object a fresh id. A clip never carries a bar number or a staff id.
 *
 * What it holds: every voice of the staff over the span (notes with their stacked pitches, grace notes, ties, articulations,
 * rests), the tuplets and slurs/ottavas wholly inside the span, the chord symbols and text of the span, and, for a span of
 * whole bars, their barlines and endings. A tuplet or slur with an end outside the span is left out, never half-copied.
 */
export const CLIP_FORMAT = 'sibei-clip';
export const CLIP_VERSION = 1;

export interface ClipVoice {
  index: number;
  /** Onsets are ticks from the clip's start (not from a bar). */
  items: BarItem[];
  tuplets: Tuplet[];
}

export interface ClipChord {
  onset: number;
  text: string;
  spellingPinned: boolean;
}

export interface ClipText {
  onset: number;
  text: string;
}

export interface ClipBar {
  startBarline: StartBarline;
  endBarline: EndBarline;
  ending: Ending | null;
}

export interface Clip {
  format: typeof CLIP_FORMAT;
  version: typeof CLIP_VERSION;
  /** The meter and key it was copied from: a paste into another meter is refused, and the key is a record, not a transposition. */
  time: TimeSignature;
  key: KeySignature;
  /** The span's length in ticks. */
  ticks: number;
  voices: ClipVoice[];
  spanners: Spanner[];
  /** Absent when the span's chord lane was not copied. */
  chords?: ClipChord[];
  annotations?: ClipText[];
  /** Only for a span of whole bars. */
  bars?: ClipBar[];
}

export interface ClipSpec {
  /** The staff, counted across the score from 1 (`s2`). */
  staff: number;
  from: { bar: number; onset?: number };
  /** Exclusive end; a bar with no onset means to the end of that bar. */
  to: { bar: number; onset?: number };
  /** Only these items (notes and rests, by id), for a selection that is not the whole span. */
  ids?: readonly Id[];
  /** Copy chord symbols and text of the span (default true). */
  harmony?: boolean;
  /** Copy barlines and endings, when the span is whole bars (default false). */
  structure?: boolean;
}

function fail(detail: string): never {
  throw new Error(detail);
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Whether a value read from JSON is a clip this version understands; the reason it is not otherwise. */
export function clipProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'a clip is a JSON object';
  const clip = value as Partial<Clip>;
  if (clip.format !== CLIP_FORMAT) return `not a clip: format must be ${JSON.stringify(CLIP_FORMAT)}`;
  if (clip.version !== CLIP_VERSION) return `clip version ${String(clip.version)} is not one this build reads (${CLIP_VERSION})`;
  if (!Number.isInteger(clip.ticks) || (clip.ticks as number) <= 0) return 'a clip has a positive length in ticks';
  if (!Array.isArray(clip.voices) || !Array.isArray(clip.spanners)) return 'a clip has voices and spanners';
  if (typeof clip.time !== 'object' || clip.time === null) return 'a clip records its meter';
  return null;
}

/** Copy a span of one staff into a clip. Throws a plain `Error` naming what is wrong with the span. */
export function copyRange(score: Score, spec: ClipSpec): Clip {
  const staff = allStaves(score)[spec.staff - 1];
  if (staff === undefined) return fail(`no staff s${spec.staff}`);
  const capacity = barCapacity(score.meta.time);
  const grid: readonly Bar[] = score.bars;
  const indexOf = (number: number): number => {
    const at = grid.findIndex((bar) => bar.number === number);
    return at < 0 ? fail(`no bar ${number}`) : at;
  };
  const first = indexOf(spec.from.bar);
  const last = indexOf(spec.to.bar);
  const start = first * capacity + (spec.from.onset ?? 0);
  const end = last * capacity + (spec.to.onset ?? capacity);
  if (end <= start) return fail('the span is empty or runs backwards');
  const only = spec.ids === undefined ? null : new Set(spec.ids);

  const voices: ClipVoice[] = [];
  const copiedNotes = new Set<Id>();
  for (const index of voiceIndexes(staff)) {
    const items: BarItem[] = [];
    const tuplets: Tuplet[] = [];
    const taken = new Set<Id>();
    for (let at = first; at <= last; at++) {
      const view = barView(score, grid[at]!, { staff: staff.id, voice: index });
      for (const item of view.items) {
        const abs = at * capacity + item.onset;
        if (abs < start || abs >= end || (only !== null && !only.has(item.id))) continue;
        items.push({ ...clone(item), onset: abs - start });
        taken.add(item.id);
      }
      for (const tuplet of view.tuplets) {
        if (tuplet.memberIds.every((id) => taken.has(id))) tuplets.push(clone(tuplet));
      }
    }
    // A member of a tuplet that is only partly in the span would be left without its bracket: leave it out.
    const bracketed = new Set(tuplets.flatMap((tuplet) => tuplet.memberIds));
    const stray = new Set(
      [...taken].filter((id) => !bracketed.has(id) && grid.some((bar) => barView(score, bar, { staff: staff.id, voice: index }).tuplets.some((t) => t.memberIds.includes(id)))),
    );
    const kept = items.filter((item) => !stray.has(item.id));
    for (const item of kept) if (item.kind === 'note') copiedNotes.add(item.id);
    if (kept.length > 0 || voices.length === 0) voices.push({ index, items: kept.sort((a, b) => a.onset - b.onset), tuplets });
  }
  const spanners = (score.spanners ?? []).filter((spanner) => copiedNotes.has(spanner.startId) && copiedNotes.has(spanner.endId)).map(clone);

  const clip: Clip = { format: CLIP_FORMAT, version: CLIP_VERSION, time: { ...score.meta.time }, key: { ...score.meta.key }, ticks: end - start, voices, spanners };

  if (spec.harmony !== false) {
    clip.chords = [];
    clip.annotations = [];
    for (let at = first; at <= last; at++) {
      const harmony = score.harmony.find((entry) => entry.barId === grid[at]!.id);
      for (const chord of harmony?.chords ?? []) {
        const abs = at * capacity + chord.onset;
        if (abs >= start && abs < end) clip.chords.push({ onset: abs - start, text: chord.text, spellingPinned: chord.spellingPinned });
      }
      for (const note of harmony?.annotations ?? []) {
        const abs = at * capacity + note.onset;
        if (abs >= start && abs < end) clip.annotations.push({ onset: abs - start, text: note.text });
      }
    }
  }
  if (spec.structure === true && start % capacity === 0 && (end - start) % capacity === 0) {
    clip.bars = grid.slice(first, last + 1).map((bar) => ({ startBarline: bar.startBarline, endBarline: bar.endBarline, ending: bar.ending === null ? null : clone(bar.ending) }));
  }
  return clip;
}
