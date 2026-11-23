import {
  MAX_CHORD_TONES,
  chordTones,
  durationTicks,
  findBarView,
  itemTicks,
  makeNote,
  makeRest,
  nextId,
  parseId,
  parsePitch,
  pitchToMidi,
  resolveAddress,
  restPieces,
  resolveStaff,
  samePitch,
  staffOf,
  voiceIndexes,
  withoutTone,
} from '@sibei/model';
import type { BarItem, BarView, ChordTone, Id, Note, Rest, Score, StackedNote, VoiceSelect } from '@sibei/model';
import { OperationError } from './errors.js';
import type { HandMovePayload, NoteMovePayload } from './operations.js';
import type { Applied } from './apply.js';

/**
 * Moving music between hands (SIB2-244, ADR-0040's piano amendment): the correction for a wrong hand split. A move is a
 * **re-home**, not an edit: the same onset and duration, a different staff or voice. `note.move` takes one note, chord or
 * pitch of a chord by its address; `hand.move` takes a bar range, optionally only the pitches below or above one.
 *
 * What a move does, and why each part is the way it is:
 * - the moved note **keeps its id** (so a slur, an address by id and the review flags survive), and a pitch taken out of a
 *   chord keeps its own id too, except the carrying pitch, which is the chord's id and so stays behind with the chord: the
 *   copy that moves gets a new one (recorded in `ids`, like every id the applier chooses, so replay and undo reproduce it);
 * - the source is **filled with a rest** of the same duration (a voice is never left with a hole), and a chord that only
 *   loses some of its pitches stays, smaller;
 * - the target must hold, over the span the note takes, **only rests or nothing** (a rest the span cuts into is split and its
 *   remainder re-written as rests), or a note of the same onset and duration, which the moved pitches join as a chord. Anything
 *   else is refused with the bar named, never overwritten: a move must not silently destroy the other hand's music
 *   (ADR-0007's strictness, ADR-0013's "never repair for rhythm").
 * - a note in a tuplet, a drum, and a note a slur starts or ends on (when the whole note moves) are refused, with the verb that
 *   frees them: a slur cannot cross voices, and moving one member of a tuplet would break the bracket.
 */

type Place = Required<VoiceSelect>;
type Rewrite = (score: Score, barId: Id, change: (bar: BarView) => BarView, select: VoiceSelect) => Score;

function fail(detail: string): never {
  throw new OperationError({ kind: 'validation', detail });
}

/** Ids the move chooses (rests, a split note's new carrier), taken from `recorded` on replay. */
function minter(score: Score, recorded: readonly Id[] | undefined) {
  const made: Id[] = [];
  const next = new Map<string, number>();
  return {
    made,
    mint(prefix: 'note' | 'rest'): Id {
      if (recorded !== undefined) {
        const id = recorded[made.length];
        if (id === undefined) return fail('this move records fewer ids than it needs');
        made.push(id);
        return id;
      }
      let ordinal = next.get(prefix);
      if (ordinal === undefined) ordinal = parseId(nextId(score, prefix))?.ordinal ?? 1;
      next.set(prefix, ordinal + 1);
      const id = `${prefix}-${ordinal}`;
      made.push(id);
      return id;
    },
  };
}

/** `s2` or `s2.v1` as a staff and voice that exist. With no voice named, `fallback` (else voice 1). */
function targetOf(score: Score, reference: string, fallback?: number): Place {
  if (typeof reference !== 'string') return fail('a move needs a destination like s2 or s2.v1');
  const found = resolveStaff(score, reference);
  const voice = found.voice ?? (fallback !== undefined && voiceIndexes(found.staff).includes(fallback) ? fallback : 1);
  if (!voiceIndexes(found.staff).includes(voice)) {
    return fail(`staff s${found.number} has no voice ${voice}; voices are ${voiceIndexes(found.staff).join(', ')} (voice add s${found.number} makes one)`);
  }
  return { staff: found.staff.id, voice };
}

function describe(score: Score, select: Place): string {
  const number = score.parts.flatMap((part) => part.staves).findIndex((staff) => staff.id === select.staff) + 1;
  return `s${number}.v${select.voice}`;
}

function tonesAsStack(tones: readonly ChordTone[], idOf: (tone: ChordTone) => Id): StackedNote[] {
  return tones.map((tone) => ({
    id: idOf(tone),
    pitch: tone.pitch,
    accidental: tone.accidental,
    tie: tone.tie,
    spellingPinned: tone.spellingPinned,
  }));
}

/** Move the picked pitches of one note from `from` to `to` in one bar. Returns the score and the moved note's id, or null if no pitch matched. */
function moveItem(
  score: Score,
  barId: Id,
  from: Place,
  to: Place,
  noteId: Id,
  pick: (tone: ChordTone) => boolean,
  mint: (prefix: 'note' | 'rest') => Id,
  rewrite: Rewrite,
): { score: Score; moved: Id } | null {
  const source = findBarView(score, barId, from);
  const note = source?.items.find((item): item is Note => item.kind === 'note' && item.id === noteId);
  if (source === undefined || note === undefined) return null;
  const tones = chordTones(note);
  const moving = tones.filter(pick);
  if (moving.length === 0) return null;
  const whole = moving.length === tones.length;
  const where = `bar ${source.number}`;

  if (note.drum !== undefined) fail(`${note.id} in ${where} is a drum hit: drums move by voice, not by hand`);
  if (staffOf(score, to)?.type === 'percussion' || staffOf(score, from)?.type === 'percussion') {
    fail(`${where}: a move does not cross a percussion staff`);
  }
  if (source.tuplets.some((tuplet) => tuplet.memberIds.includes(note.id))) {
    fail(`${note.id} in ${where} is in a tuplet: take the bracket off (tuplet rm ${note.id}) before moving it`);
  }
  if (moving.some((tone) => tone.primary) && whole && (score.spanners ?? []).some((s) => s.startId === note.id || s.endId === note.id)) {
    fail(`${note.id} in ${where} has a slur or ottava on it, which cannot cross staves: remove it first (slur rm / ottava rm)`);
  }

  const ticks = itemTicks(note, source);
  const end = note.onset + ticks;
  const target = findBarView(score, barId, to);
  if (target === undefined) return fail(`${where} has no ${describe(score, to)}`);
  const over = target.items.filter((item) => item.onset < end && item.onset + itemTicks(item, target) > note.onset);
  const host = over.find((item): item is Note => item.kind === 'note');

  // The pitches as the target will hold them. A chord's carrying pitch is the chord's own id, which stays with the chord.
  const idOf = (tone: ChordTone): Id => (tone.primary && !whole ? mint('note') : tone.id);
  const movedIds = new Map<Id, Id>();
  for (const tone of moving) movedIds.set(tone.id, idOf(tone));

  let arrived: Note;
  let kept: BarItem[];
  if (host !== undefined) {
    if (over.length !== 1 || host.onset !== note.onset || durationTicks(host.duration) !== durationTicks(note.duration)) {
      fail(`${where}: ${describe(score, to)} already has a note overlapping this one that is not this note's length; clear it first, or move to a free staff`);
    }
    if ((note.graces ?? []).length > 0 && whole) fail(`${note.id} in ${where} has grace notes, which cannot join another chord: remove them first (grace rm)`);
    const clash = moving.find((tone) => chordTones(host).some((own) => samePitch(own.pitch, tone.pitch)));
    if (clash !== undefined) fail(`${where}: ${describe(score, to)} already has that pitch in its chord`);
    if (chordTones(host).length + moving.length > MAX_CHORD_TONES) fail(`a chord holds at most ${MAX_CHORD_TONES} pitches`);
    const extra = tonesAsStack(moving, (tone) => movedIds.get(tone.id)!);
    arrived = { ...host, stack: [...(host.stack ?? []), ...extra] };
    kept = target.items.filter((item) => item.id !== host.id);
  } else {
    if (over.some((item) => target.tuplets.some((tuplet) => tuplet.memberIds.includes(item.id)))) {
      fail(`${where}: the rests under this note are in a tuplet on ${describe(score, to)}: take the bracket off first`);
    }
    if (whole) {
      arrived = note;
    } else {
      const order = [...moving].sort((a, b) => pitchToMidi(b.pitch) - pitchToMidi(a.pitch));
      const [head, ...others] = order as [ChordTone, ...ChordTone[]];
      arrived = makeNote({
        id: movedIds.get(head.id)!,
        onset: note.onset,
        duration: note.duration,
        pitch: head.pitch,
        accidental: head.accidental,
        tie: head.tie,
        spellingPinned: head.spellingPinned,
        confidence: note.confidence,
        review: note.review,
      });
      if (others.length > 0) arrived.stack = tonesAsStack(others, (tone) => movedIds.get(tone.id)!);
    }
    // The rests the span covered go; the parts of them it did not cover are written again.
    const refill: Rest[] = [];
    for (const rest of over as Rest[]) {
      const restEnd = rest.onset + itemTicks(rest, target);
      const piece = (from: number, until: number): void => {
        let at = from;
        for (const duration of restPieces(from, until - from)) {
          refill.push(makeRest({ id: mint('rest'), onset: at, duration }));
          at += durationTicks(duration);
        }
      };
      if (rest.onset < note.onset) piece(rest.onset, note.onset);
      if (restEnd > end) piece(end, restEnd);
    }
    kept = [...target.items.filter((item) => !over.includes(item)), ...refill];
  }

  // The source gives the pitches up: a rest where the whole note was, the chord smaller where it was part of one.
  let sourceItem: BarItem;
  if (whole) {
    sourceItem = makeRest({ id: mint('rest'), onset: note.onset, duration: note.duration });
  } else {
    let left: Note | null = note;
    for (const tone of moving) left = left === null ? null : withoutTone(left, tone.id);
    sourceItem = left!;
  }

  let next = rewrite(score, barId, (bar) => ({
    ...bar,
    items: bar.items.map((item) => (item.id === note.id ? sourceItem : item)),
  }), from);
  next = rewrite(next, barId, (bar) => ({ ...bar, items: [...kept, arrived].sort((a, b) => a.onset - b.onset) }), to);
  return { score: next, moved: arrived.id };
}

/** `note.move`: one note, chord or pitch of a chord (`bar3.n2`, `s1.bar3.beat2.E4`) to another staff or voice. */
export function moveNote(score: Score, target: string, payload: NoteMovePayload, rewrite: Rewrite): Applied {
  const resolved = resolveAddress(score, target, 'note');
  const staff = staffOf(score, resolved.select);
  if (staff === undefined) return fail(`${target} is on no staff`);
  const from: Place = { staff: staff.id, voice: resolved.select.voice ?? 1 };
  const to = targetOf(score, payload.to);
  if (to.staff === from.staff && to.voice === from.voice) fail(`${target} is already on ${describe(score, to)}`);
  const minting = minter(score, payload.ids);
  const picked = resolved.tone === undefined ? undefined : resolved.tone.id;
  const done = moveItem(score, resolved.bar.id, from, to, resolved.target.id, (tone) => picked === undefined || tone.id === picked, minting.mint, rewrite);
  if (done === null) return fail(`${target} has nothing to move`);
  return {
    score: done.score,
    operation: { type: 'note.move', target, payload: { ...payload, ids: minting.made } },
    changed: [done.moved],
  };
}

function bound(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fail(`${name} is a bar number`);
  return value;
}

function pitchBound(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return fail(`${name} is a pitch like C4`);
  try {
    return pitchToMidi(parsePitch(value));
  } catch {
    return fail(`${name} is a pitch like C4, not ${JSON.stringify(value)}`);
  }
}

/**
 * `hand.move`: every note of one staff (or one voice of it) in a bar range to another, optionally only the pitches below
 * `below` or at and above `above`. A pitch of a chord that is picked and one that is not part company: the chord splits.
 */
export function moveHand(score: Score, payload: HandMovePayload, rewrite: Rewrite): Applied {
  const first = bound(payload.first, 'first');
  const last = bound(payload.last, 'last');
  if (first > last) fail(`the bar range runs ${first} to ${last}; it must not run backwards`);
  const source = resolveStaff(score, payload.from);
  const below = pitchBound(payload.below, 'below');
  const above = pitchBound(payload.above, 'above');
  const voices = source.voice === undefined ? voiceIndexes(source.staff) : [source.voice];
  const pick = (tone: ChordTone): boolean => {
    const midi = pitchToMidi(tone.pitch);
    return (below === undefined || midi < below) && (above === undefined || midi >= above);
  };
  const minting = minter(score, payload.ids);
  const changed: Id[] = [];
  let current = score;
  const bars = score.bars.filter((bar) => bar.number >= first && bar.number <= last);
  if (bars.length === 0) {
    fail(`there are no bars from ${first} to ${last}; bars are ${score.bars.map((bar) => bar.number).join(', ')}`);
  }
  for (const bar of bars) {
    for (const voice of voices) {
      const from: Place = { staff: source.staff.id, voice };
      const to = targetOf(current, payload.to, voice);
      if (to.staff === from.staff && to.voice === from.voice) fail(`${payload.from} is already ${describe(score, to)}`);
      const ids = (findBarView(current, bar.id, from)?.items ?? []).filter((item) => item.kind === 'note').map((item) => item.id);
      for (const id of ids) {
        const done = moveItem(current, bar.id, from, to, id, pick, minting.mint, rewrite);
        if (done === null) continue;
        current = done.score;
        changed.push(done.moved);
      }
    }
  }
  if (changed.length === 0) fail(`no notes in bars ${first} to ${last} of ${payload.from} match, so nothing moved`);
  return {
    score: current,
    operation: { type: 'hand.move', payload: { ...payload, ids: minting.made } },
    changed,
  };
}
