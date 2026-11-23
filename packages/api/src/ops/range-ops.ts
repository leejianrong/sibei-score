import { allStaves, barCapacity, clipProblem, noReview, nextId, parseId, resolvePosition, staffOf, voiceIndexes } from '@sibei/model';
import type { Annotation, BarItem, BarView, Chord, Clip, Id, Note, Rest, Score, Spanner, Tuplet, VoiceSelect } from '@sibei/model';
import { OperationError } from './errors.js';
import type { RangeClearPayload, RangePastePayload } from './operations.js';
import type { Applied } from './apply.js';

/**
 * Copy and paste for ranges (SIB2-279): `range.paste` lays a clip (`@sibei/model`'s `Clip`, what `sbscore range copy` prints)
 * at an address, and `range.clear` empties whole bars of a staff. Copying itself is a read (`copyRange`), so it is not an
 * op; the clip a paste carries is its payload, which is what makes a paste replay exactly from the log and lets an agent
 * paste inside a `batch`.
 *
 * What a paste does, and why:
 * - it **replaces the span**: every item (and chord symbol, if the clip has them) of the voices it writes, from the target to
 *   the target plus the clip's length, goes first. A paste is a decision about that stretch; anything it did not name is
 *   left alone. A tuplet cut into by the span goes with its members, and so does a slur or ottava on a removed note.
 * - the target address is strict like every other (ADR-0007): a staff with more than one voice needs `s1.v2.bar3.beat1`. A
 *   one-voice clip lands in the addressed voice; a many-voice clip lands in the same-numbered voices, which must exist.
 * - positions are ticks from the span's start, so a clip pastes at any beat; an item that then crosses a barline is stored
 *   and flagged (ADR-0013), a tuplet that would straddle one is refused, and a span past the last bar is refused with the
 *   number of bars to add first.
 * - every pasted object gets a **fresh id**, recorded in `ids` in the order made so replay and undo reproduce it (ADR-0003).
 * - the clip's key is a record, not an instruction: a paste never transposes.
 */

type Place = Required<VoiceSelect>;
type Rewrite = (score: Score, barId: Id, change: (bar: BarView) => BarView, select: VoiceSelect) => Score;
type Prefix = 'note' | 'rest' | 'tuplet' | 'grace' | 'slur' | 'ottava' | 'hairpin' | 'chord' | 'annotation';

function fail(detail: string): never {
  throw new OperationError({ kind: 'validation', detail });
}

function minter(score: Score, recorded: readonly Id[] | undefined) {
  const made: Id[] = [];
  const next = new Map<string, number>();
  return {
    made,
    mint(prefix: Prefix): Id {
      if (recorded !== undefined) {
        const id = recorded[made.length];
        if (id === undefined) return fail('this paste records fewer ids than it needs');
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

/** `[low, high)` in ticks, on the chart's bar grid. */
interface Span {
  start: number;
  end: number;
}

function removeFromView(view: BarView, at: number, capacity: number, span: Span, removed: Set<Id>, what: { items: boolean; harmony: boolean }): BarView {
  const inside = (onset: number): boolean => at * capacity + onset >= span.start && at * capacity + onset < span.end;
  const doomed = what.items ? view.items.filter((item) => inside(item.onset)) : [];
  for (const item of doomed) {
    removed.add(item.id);
    if (item.kind === 'note') for (const tone of item.stack ?? []) removed.add(tone.id);
  }
  const gone = new Set(doomed.map((item) => item.id));
  return {
    ...view,
    items: view.items.filter((item) => !gone.has(item.id)),
    tuplets: view.tuplets.filter((tuplet) => !tuplet.memberIds.some((id) => gone.has(id))),
    ...(what.harmony
      ? { chords: view.chords.filter((chord) => !inside(chord.onset)), annotations: view.annotations.filter((note) => !inside(note.onset)) }
      : {}),
  };
}

function withoutSpanners(score: Score, removed: ReadonlySet<Id>): Score {
  if (score.spanners === undefined || removed.size === 0) return score;
  return { ...score, spanners: score.spanners.filter((s) => !removed.has(s.startId) && !removed.has(s.endId)) };
}

/** `range.paste`: the clip's span of music onto the target address, replacing what was there. */
export function pasteRange(score: Score, target: string, payload: RangePastePayload, rewrite: Rewrite): Applied {
  const problem = clipProblem(payload?.clip);
  if (problem !== null) fail(problem);
  const clip: Clip = payload.clip;
  const capacity = barCapacity(score.meta.time);
  if (barCapacity(clip.time) !== capacity) {
    fail(`the clip was copied from ${clip.time.beats}/${clip.time.beatValue}, which holds a different bar than this chart's ${score.meta.time.beats}/${score.meta.time.beatValue}`);
  }
  const position = resolvePosition(score, target);
  const staff = staffOf(score, position.select);
  if (staff === undefined) return fail(`${target} names no staff`);
  const firstIndex = score.bars.findIndex((bar) => bar.id === position.bar.id);
  const span: Span = { start: firstIndex * capacity + position.onset, end: firstIndex * capacity + position.onset + clip.ticks };
  const lastIndex = Math.floor((span.end - 1) / capacity);
  if (lastIndex >= score.bars.length) {
    const missing = lastIndex + 1 - score.bars.length;
    fail(`the clip is ${clip.ticks} ticks long and reaches ${missing} bar${missing === 1 ? '' : 's'} past the end: add ${missing === 1 ? 'it' : 'them'} first (bar add)`);
  }

  // Where each clip voice goes.
  const voices = voiceIndexes(staff);
  const lanes = clip.voices.map((voice) => {
    const to = clip.voices.length === 1 ? (position.select.voice ?? 1) : voice.index;
    if (!voices.includes(to)) fail(`the clip has a voice ${voice.index}, and this staff has no voice ${to} (voice add makes one)`);
    return { voice, to };
  });
  if (new Set(lanes.map((lane) => lane.to)).size !== lanes.length) fail('two voices of the clip would land in one voice');

  const minting = minter(score, payload.ids);
  const idMap = new Map<Id, Id>();
  const remap = (id: Id): Id => idMap.get(id) ?? fail(`the clip refers to ${id}, which it does not contain`);

  // Mint in one fixed order (voice, then item, then its pitches and graces, then the voice's tuplets, spanners, chords).
  const placed = lanes.map(({ voice, to }) => ({
    to,
    items: voice.items.map((item): BarItem => {
      if (item.kind === 'rest') {
        const rest: Rest = { ...item, id: minting.mint('rest') };
        idMap.set(item.id, rest.id);
        return rest;
      }
      const note: Note = { ...item, id: minting.mint('note') };
      idMap.set(item.id, note.id);
      if (item.stack !== undefined) {
        note.stack = item.stack.map((tone) => {
          const id = minting.mint('note');
          idMap.set(tone.id, id);
          return { ...tone, id };
        });
      }
      if (item.graces !== undefined) note.graces = item.graces.map((grace) => ({ ...grace, id: minting.mint('grace') }));
      return note;
    }),
    tuplets: voice.tuplets.map((tuplet): Tuplet => ({ ...tuplet, id: minting.mint('tuplet'), memberIds: tuplet.memberIds.map(remap) })),
  }));
  const spanners: Spanner[] = clip.spanners.map((spanner) => ({
    ...spanner,
    id: minting.mint(spanner.kind),
    startId: remap(spanner.startId),
    endId: remap(spanner.endId),
  }));
  const harmony = clip.chords !== undefined || clip.annotations !== undefined;
  const chords: Chord[] = (clip.chords ?? []).map((chord) => ({
    id: minting.mint('chord'),
    onset: chord.onset,
    text: chord.text,
    spellingPinned: chord.spellingPinned,
    confidence: null,
    review: noReview(),
  }));
  const notes: Annotation[] = (clip.annotations ?? []).map((note) => ({
    id: minting.mint('annotation'),
    onset: note.onset,
    text: note.text,
    confidence: null,
    review: noReview(),
  }));

  // A tuplet's members must stay in one bar.
  for (const lane of placed) {
    for (const tuplet of lane.tuplets) {
      const bars = new Set(
        tuplet.memberIds.map((id) => Math.floor((span.start + lane.items.find((item) => item.id === id)!.onset) / capacity)),
      );
      if (bars.size > 1) fail('a tuplet in the clip would straddle a barline at this position: paste at a beat that keeps it inside one bar');
    }
  }

  const removed = new Set<Id>();
  let current = score;
  for (let at = firstIndex; at <= lastIndex; at++) {
    const barId = score.bars[at]!.id;
    const inBar = (relative: number): boolean => {
      const abs = span.start + relative;
      return abs >= at * capacity && abs < (at + 1) * capacity;
    };
    lanes.forEach((lane, order) => {
      const mine = placed[order]!;
      current = rewrite(
        current,
        barId,
        (view) => {
          const cleared = removeFromView(view, at, capacity, span, removed, { items: true, harmony: false });
          const items = mine.items.filter((item) => inBar(item.onset)).map((item) => ({ ...item, onset: span.start + item.onset - at * capacity }));
          const ids = new Set(items.map((item) => item.id));
          const tuplets = mine.tuplets.filter((tuplet) => tuplet.memberIds.every((id) => ids.has(id)));
          return { ...cleared, items: [...cleared.items, ...items].sort((a, b) => a.onset - b.onset), tuplets: [...cleared.tuplets, ...tuplets] };
        },
        { staff: staff.id, voice: lane.to },
      );
    });
    if (harmony) {
      current = rewrite(
        current,
        barId,
        (view) => {
          const cleared = removeFromView(view, at, capacity, span, new Set(), { items: false, harmony: true });
          const shift = (onset: number): number => span.start + onset - at * capacity;
          return {
            ...cleared,
            chords: [...cleared.chords, ...chords.filter((chord) => inBar(chord.onset)).map((chord) => ({ ...chord, onset: shift(chord.onset) }))].sort((a, b) => a.onset - b.onset),
            annotations: [...cleared.annotations, ...notes.filter((note) => inBar(note.onset)).map((note) => ({ ...note, onset: shift(note.onset) }))].sort((a, b) => a.onset - b.onset),
          };
        },
        { staff: staff.id, voice: lanes[0]!.to },
      );
    }
  }
  current = withoutSpanners(current, removed);
  if (spanners.length > 0) current = { ...current, spanners: [...(current.spanners ?? []), ...spanners] };

  // Barlines and endings travel with a span of whole bars pasted on a bar line.
  if (clip.bars !== undefined && span.start % capacity === 0 && clip.ticks % capacity === 0) {
    current = {
      ...current,
      bars: current.bars.map((bar, at) => {
        const carried = clip.bars![at - firstIndex];
        return carried === undefined ? bar : { ...bar, startBarline: carried.startBarline, endBarline: carried.endBarline, ending: carried.ending };
      }),
    };
  }

  return {
    score: current,
    operation: { type: 'range.paste', target, payload: { ...payload, ids: minting.made } },
    changed: minting.made,
  };
}

/** `range.clear`: every item of a staff (all voices) in whole bars `first` to `last`, and with `harmony` their chords and text. */
export function clearRange(score: Score, payload: RangeClearPayload, rewrite: Rewrite): Applied {
  const staves = allStaves(score);
  const reference = typeof payload.staff === 'string' ? /^s(\d+)$/.exec(payload.staff) : null;
  const staff = reference === null ? undefined : staves[Number(reference[1]) - 1];
  if (staff === undefined) return fail(`a range is cleared on a staff like s1; ${JSON.stringify(payload.staff)} is not one of this chart's ${staves.length}`);
  if (!Number.isInteger(payload.first) || !Number.isInteger(payload.last) || payload.first > payload.last) {
    fail('range.clear takes whole bar numbers, first not after last');
  }
  const capacity = barCapacity(score.meta.time);
  const bars = score.bars.filter((bar) => bar.number >= payload.first && bar.number <= payload.last);
  if (bars.length === 0) fail(`there are no bars from ${payload.first} to ${payload.last}`);
  const removed = new Set<Id>();
  let current = score;
  const everything: Span = { start: -Infinity, end: Infinity };
  for (const bar of bars) {
    const at = score.bars.indexOf(bar);
    for (const voice of voiceIndexes(staff)) {
      current = rewrite(current, bar.id, (view) => removeFromView(view, at, capacity, everything, removed, { items: true, harmony: false }), { staff: staff.id, voice });
    }
    if (payload.harmony === true) {
      current = rewrite(current, bar.id, (view) => removeFromView(view, at, capacity, everything, new Set(), { items: false, harmony: true }), { staff: staff.id, voice: 1 });
    }
  }
  if (removed.size === 0 && payload.harmony !== true) fail(`bars ${payload.first} to ${payload.last} of s${reference![1]} hold nothing to clear`);
  return { score: withoutSpanners(current, removed), operation: { type: 'range.clear', payload: { ...payload } }, changed: [...removed] };
}
