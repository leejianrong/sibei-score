import { STEPS, allBarViews, barCapacity, itemTicks, keySignatureAccidentals, allStaves, chordTones, formatPitch, formatBeat, beatOfOnset } from '@sibei/model';
import type { Articulation, ClipSpec, Duration, Id, Pitch, Score, TieRole } from '@sibei/model';
import type { Operation } from './api.js';
import type { Lane } from './lanes.js';
import { qualifierOf } from './lanes.js';

/**
 * Selecting many notes and acting on them at once (SIB2-278), the pure half.
 *
 * A selection is a list of item ids (notes and rests, by the ids every op already resolves). The functions here pick
 * which ids a gesture means (a range between two clicks, a bar range, a whole staff) and turn one edit into a list of
 * **ordinary ops** over them (`note.set`, `note.rm`, `rest.rm`/`rest.add`, `note.move`). The caller submits that list as
 * one batch, so one ctrl-Z reverses the whole edit (ADR-0003), and every edit already has a CLI verb (Q79).
 */

interface Entry {
  id: Id;
  kind: 'note' | 'rest';
  lane: Lane;
  bar: number;
  onset: number;
  beat: number;
  duration: Duration;
  ticks: number;
  /** Every pitch of a note, lowest first, each with the id the ops resolve; empty for a rest. */
  tones: { id: Id; pitch: Pitch; primary: boolean }[];
}

/** Every item of the chart, lane by lane (staff, then voice), each lane in reading order. */
function entries(score: Score): Entry[] {
  const staves = allStaves(score);
  const out: Entry[] = [];
  for (const { select, views } of allBarViews(score)) {
    const lane: Lane = { staff: staves.findIndex((staff) => staff.id === select.staff) + 1, voice: select.voice };
    for (const view of views) {
      for (const item of [...view.items].sort((a, b) => a.onset - b.onset)) {
        out.push({
          id: item.id,
          kind: item.kind,
          lane,
          bar: view.number,
          onset: item.onset,
          beat: beatOfOnset(item.onset, score.meta.time),
          duration: item.duration,
          ticks: itemTicks(item, view),
          tones: item.kind === 'note' ? chordTones(item).map((tone) => ({ id: tone.id, pitch: tone.pitch, primary: tone.primary })) : [],
        });
      }
    }
  }
  return out.sort((a, b) => a.lane.staff - b.lane.staff || a.lane.voice - b.lane.voice || a.bar - b.bar || a.onset - b.onset);
}

function sameLane(a: Lane, b: Lane): boolean {
  return a.staff === b.staff && a.voice === b.voice;
}

/** The items from one click to another, inclusive, in the first one's lane; two lanes have no order, so just the pair. */
export function itemsBetween(score: Score, from: Id, to: Id): Id[] {
  const all = entries(score);
  const a = all.findIndex((entry) => entry.id === from || entry.tones.some((tone) => tone.id === from));
  const b = all.findIndex((entry) => entry.id === to || entry.tones.some((tone) => tone.id === to));
  if (a < 0 || b < 0) return [from, to];
  if (!sameLane(all[a]!.lane, all[b]!.lane)) return [all[a]!.id, all[b]!.id];
  const [low, high] = a <= b ? [a, b] : [b, a];
  return all.slice(low, high + 1).map((entry) => entry.id);
}

/** Every item of a staff (every voice of it) inside a bar range, bar numbers inclusive. */
export function itemsInBars(score: Score, staff: number, first: number, last: number): Id[] {
  const [low, high] = first <= last ? [first, last] : [last, first];
  return entries(score)
    .filter((entry) => entry.lane.staff === staff && entry.bar >= low && entry.bar <= high)
    .map((entry) => entry.id);
}

/** Every item of a staff. */
export function itemsInStaff(score: Score, staff: number): Id[] {
  return entries(score)
    .filter((entry) => entry.lane.staff === staff)
    .map((entry) => entry.id);
}

/** The ids as they are still in the score, in reading order, without repeats: what a stale selection falls back to. */
export function liveItems(score: Score, ids: readonly Id[]): Id[] {
  const wanted = new Set(ids);
  return entries(score)
    .filter((entry) => wanted.has(entry.id))
    .map((entry) => entry.id);
}

/** How many of the ids are notes (the rest are rests). */
export function countNotes(score: Score, ids: readonly Id[]): number {
  const wanted = new Set(ids);
  return entries(score).filter((entry) => wanted.has(entry.id) && entry.kind === 'note').length;
}

/**
 * The span the selected items cover, as the `ClipSpec` that copies them, and the position just after it (for Duplicate).
 * One staff: the first picked item's. `null` when none of the ids is in the score.
 */
export function selectionSpan(score: Score, ids: readonly Id[]): { spec: ClipSpec; after: { bar: number; onset: number }; lane: Lane; first: { bar: number; onset: number } } | null {
  const wanted = new Set(ids);
  const chosen = entries(score).filter((entry) => wanted.has(entry.id));
  const head = chosen[0];
  if (head === undefined) return null;
  const mine = chosen.filter((entry) => entry.lane.staff === head.lane.staff);
  const capacity = barCapacity(score.meta.time);
  const bars = score.bars.map((bar) => bar.number);
  const abs = (entry: Entry): number => bars.indexOf(entry.bar) * capacity + entry.onset;
  const start = Math.min(...mine.map(abs));
  const end = Math.max(...mine.map((entry) => abs(entry) + entry.ticks));
  const at = (tick: number): { bar: number; onset: number } => ({ bar: bars[Math.floor(tick / capacity)] ?? bars[bars.length - 1]! + 1, onset: tick % capacity });
  const first = at(start);
  return {
    spec: { staff: head.lane.staff, from: first, to: { bar: bars[Math.floor((end - 1) / capacity)]!, onset: ((end - 1) % capacity) + 1 }, ids: mine.map((entry) => entry.id) },
    after: at(end),
    lane: head.lane,
    first,
  };
}

export type SelectionEdit =
  | { type: 'delete' }
  /** Diatonic steps (an octave is 7); the written accidental is kept. */
  | { type: 'step'; steps: number }
  | { type: 'duration'; duration: Duration }
  | { type: 'move'; to: string }
  | { type: 'tie'; on: boolean }
  | { type: 'articulation'; marks: Articulation[] };

/**
 * A pitch moved by diatonic steps. The written accidental goes with the old step, so the new one takes what the key
 * signature gives it (`alterOf`), or keeps the old one when there is no key to ask.
 */
export function shiftPitch(pitch: Pitch, steps: number, alterOf?: (step: Pitch['step']) => Pitch['alter']): Pitch {
  const index = pitch.octave * 7 + STEPS.indexOf(pitch.step) + steps;
  const octave = Math.floor(index / 7);
  const step = STEPS[index - octave * 7]!;
  return { step, alter: alterOf === undefined ? pitch.alter : alterOf(step), octave };
}

/** The ops of one edit over the selected items, in an order the applier accepts; submit them as one batch. */
export function selectionOps(score: Score, ids: readonly Id[], edit: SelectionEdit): Operation[] {
  const picked = new Set(ids);
  const chosen = entries(score).filter((entry) => picked.has(entry.id));
  const notes = chosen.filter((entry) => entry.kind === 'note');
  const ops: Operation[] = [];
  const inKey = keySignatureAccidentals(score.meta.key);
  switch (edit.type) {
    case 'delete':
      for (const entry of chosen) ops.push({ type: entry.kind === 'note' ? 'note.rm' : 'rest.rm', target: entry.id });
      return ops;

    case 'step':
      for (const entry of notes) {
        // A chord's tones move together, the ones the move would land on first out of the way.
        const tones = edit.steps > 0 ? [...entry.tones].reverse() : entry.tones;
        for (const tone of tones) {
          ops.push({ type: 'note.set', target: tone.id, payload: { pitch: formatPitch(shiftPitch(tone.pitch, edit.steps, (step) => inKey.get(step) ?? 0)) } });
        }
      }
      return ops;

    case 'duration':
      for (const entry of chosen) {
        if (entry.kind === 'note') {
          ops.push({ type: 'note.set', target: entry.id, payload: { duration: edit.duration } });
        } else {
          const here = qualifierOf(score, entry.lane);
          ops.push({ type: 'rest.rm', target: entry.id });
          ops.push({ type: 'rest.add', target: `${here}bar${entry.bar}.beat${formatBeat(entry.beat)}`, payload: { duration: edit.duration } });
        }
      }
      return ops;

    case 'move':
      for (const entry of notes) ops.push({ type: 'note.move', target: entry.id, payload: { to: edit.to } });
      return ops;

    case 'tie': {
      // Ties join the notes of one lane that follow each other in the selection: the last one has nothing to tie to.
      notes.forEach((entry, at) => {
        const next = notes[at + 1];
        const before = at > 0 && sameLane(notes[at - 1]!.lane, entry.lane);
        const after = next !== undefined && sameLane(next.lane, entry.lane);
        const role: TieRole = !edit.on ? 'none' : before && after ? 'both' : before ? 'stop' : after ? 'start' : 'none';
        for (const tone of entry.tones) ops.push({ type: 'note.set', target: tone.id, payload: { tie: role } });
      });
      return ops;
    }

    case 'articulation':
      for (const entry of notes) {
        ops.push({ type: 'note.set', target: entry.id, payload: { articulations: edit.marks } });
      }
      return ops;
  }
}

/** Where the arrow keys can send a selection (SIB2-268). */
export type ArrowStep = 'next' | 'prev' | 'next-bar' | 'prev-bar' | 'up' | 'down';

/**
 * The item an arrow key moves the selection to, from the item `from` (a note's id, or any tone of a chord).
 *
 * `next`/`prev` walk the item's own lane (staff and voice) in reading order, across barlines; `next-bar`/`prev-bar` jump to
 * the first item of the nearest bar that has one in that lane; `up`/`down` cross to the staff above or below (the same voice,
 * else the lowest voice it has), landing on the item of the same bar nearest the same place in it. `null` is "nowhere to
 * go", so the caller leaves the selection alone.
 */
export function neighbourItem(score: Score, from: Id, step: ArrowStep): Id | null {
  const all = entries(score);
  const at = all.findIndex((entry) => entry.id === from || entry.tones.some((tone) => tone.id === from));
  if (at < 0) return null;
  const here = all[at]!;
  const lane = all.filter((entry) => sameLane(entry.lane, here.lane));
  const index = lane.indexOf(here);
  switch (step) {
    case 'next':
      return lane[index + 1]?.id ?? null;
    case 'prev':
      return lane[index - 1]?.id ?? null;
    case 'next-bar':
      return lane.find((entry) => entry.bar > here.bar)?.id ?? null;
    case 'prev-bar': {
      const before = lane.filter((entry) => entry.bar < here.bar);
      const bar = before[before.length - 1]?.bar;
      return bar === undefined ? null : before.find((entry) => entry.bar === bar)!.id;
    }
    case 'up':
    case 'down': {
      const staff = here.lane.staff + (step === 'up' ? -1 : 1);
      const there = all.filter((entry) => entry.lane.staff === staff && entry.bar === here.bar);
      if (there.length === 0) return null;
      const voice = there.some((entry) => entry.lane.voice === here.lane.voice) ? here.lane.voice : Math.min(...there.map((entry) => entry.lane.voice));
      const inVoice = there.filter((entry) => entry.lane.voice === voice);
      return inVoice.reduce((best, entry) => (Math.abs(entry.onset - here.onset) < Math.abs(best.onset - here.onset) ? entry : best)).id;
    }
  }
}

/** The first or last item of a lane (of one bar of it, when given), for an arrow key pressed with nothing selected. */
export function edgeItem(score: Score, lane: Lane, which: 'first' | 'last', bar?: number): Id | null {
  const inLane = entries(score).filter((entry) => sameLane(entry.lane, lane) && (bar === undefined || entry.bar === bar));
  return (which === 'first' ? inLane[0] : inLane[inLane.length - 1])?.id ?? null;
}
