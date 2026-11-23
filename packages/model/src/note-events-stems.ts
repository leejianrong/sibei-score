/**
 * Several NoteEvents documents, one per separated stem, onto one multi-part score (SIB2-147, ADR-0040 amendment
 * "several stems", the audio repo's ADR-0002: "a separated multi-instrument job produces one NoteEvents per stem").
 *
 * Pure and framework-free like the single-stem mappers it composes. The point of this file is the *shared* parts:
 *
 * - **One bar grid for the whole score.** Every stem was cut from one recording, so one beat grid describes them
 *   all. It is taken from the stem whose grid is best ({@link pickGridStem}) and handed to every stem's own mapper
 *   (melody/bass/voice quantizer, piano hand-split mapper, drum mapper), so bar N is the same bar in every part. Time
 *   signature, pickup and the bar span (the union of what each stem covers; a stem that starts late opens with rests)
 *   are inferred once.
 * - **One key**, inferred over every pitched stem together, so a bass line and a piano are spelled alike.
 * - **Parts in conventional order** (voice, then the harmony instruments, bass, drums), named, with GM programs.
 * - **Every doubt kept**: each stem's warnings and review flags survive, the warnings prefixed by the stem's
 *   instrument in the diagnostics. A stem with no notes is an empty part with a warning, never an error; bar 1 is
 *   flagged when the barring is a guess (ADR-0019), as for one stem.
 *
 * Stems must come from one recording: the same `source.sha256` and (within {@link DURATION_EPSILON_S}) the same
 * `source.duration_s`. A set that does not is refused as a whole ({@link checkStems}), never half-imported.
 *
 * A stem whose instrument this build cannot notate (`guitar`, `other`) is **kept as a plain melody staff with a
 * warning** rather than refused: refusing it would throw away the band over one stem. Its chords collapse to one
 * line, which the warning says. (A lone document with such an instrument is still refused at the boundary, as in v1.)
 */

import { makeRest } from './build.js';
import { durationTicks } from './duration.js';
import { NoteEventsError } from './note-events.js';
import type { NoteEvents, NoteEventsInstrument } from './note-events.js';
import { mapNoteEventsToScore, inferKey } from './note-events-map.js';
import type { NoteEventsDraft, NoteEventsMapOptions } from './note-events-map.js';
import { restPieces } from './note-events-drums.js';
import { beatGrid } from './note-events-quantize.js';
import type { BarSpan, BeatGrid, QuantizedItem, SharedGrid } from './note-events-quantize.js';
import type { Bar, BarItem, Clef, KeySignature, Part, Score, Staff, StaffBar } from './score.js';

/** The most stems one result may carry: a full mix separates into a handful, and a bound keeps the work bounded. */
export const MAX_STEMS = 12;

/** Stems of one recording agree on length to within this many seconds (float round-trips, not real disagreement). */
export const DURATION_EPSILON_S = 0.01;

/** The order parts appear in: melody first, then harmony instruments, bass, drums (a conventional score order). */
const PART_RANK: Record<NoteEventsInstrument, number> = { voice: 0, guitar: 1, piano: 2, other: 3, bass: 4, drums: 5 };

/** Which stem's grid wins a tie, and which stem leads when no stem has a grid: drums, bass, piano, voice, other. */
const GRID_RANK: Record<NoteEventsInstrument, number> = { drums: 0, bass: 1, piano: 2, voice: 3, guitar: 4, other: 5 };

const PART_NAME: Record<NoteEventsInstrument, string> = { voice: 'Voice', guitar: 'Guitar', piano: 'Piano', other: 'Other', bass: 'Bass', drums: 'Drums' };

/** General MIDI programs: 54 Voice Oohs, 24 nylon guitar, 0 acoustic piano, 33 electric bass (finger); percussion has none. */
const PART_PROGRAM: Record<NoteEventsInstrument, number | null> = { voice: 54, guitar: 24, piano: 0, other: null, bass: 33, drums: null };

/** Problems that make a set of stems unusable together; empty when they are consistent. Each names the stem index. */
export function checkStems(stems: readonly NoteEvents[]): string[] {
  const problems: string[] = [];
  if (stems.length === 0) return ['stems is empty: a multi-stem result carries at least one NoteEvents'];
  if (stems.length > MAX_STEMS) problems.push(`stems has ${stems.length} entries; at most ${MAX_STEMS} are read`);
  const first = stems[0]!;
  stems.forEach((stem, index) => {
    if (index === 0) return;
    if (stem.source.sha256 !== first.source.sha256) {
      problems.push(`stems[${index}].source.sha256 differs from stems[0]'s: the stems are not from one recording`);
    }
    if (Math.abs(stem.source.duration_s - first.source.duration_s) > DURATION_EPSILON_S) {
      problems.push(`stems[${index}].source.duration_s (${stem.source.duration_s}) differs from stems[0]'s (${first.source.duration_s})`);
    }
  });
  return problems;
}

/**
 * The stem whose beat grid describes the recording best: a usable grid (two or more distinct beats) beats none,
 * then marked downbeats, then the most beats, then {@link GRID_RANK}. With no usable grid anywhere, the stem with the
 * most notes (the best material to infer a tempo from), ties again by rank. Returns an index into `stems`.
 */
export function pickGridStem(stems: readonly NoteEvents[]): number {
  const info = stems.map((s, index) => {
    const times = s.beats.map((b) => b.t_s);
    const usable = s.beats.length >= 2 && Math.max(...times) > Math.min(...times);
    return { index, usable, down: usable && s.beats.some((b) => b.is_downbeat === true), beats: usable ? s.beats.length : 0, notes: s.notes.length, rank: GRID_RANK[s.instrument] };
  });
  const better = (a: (typeof info)[number], b: (typeof info)[number]): boolean => {
    if (a.usable !== b.usable) return a.usable;
    if (a.usable) {
      if (a.down !== b.down) return a.down;
      if (a.beats !== b.beats) return a.beats > b.beats;
    } else if (a.notes !== b.notes) return a.notes > b.notes;
    return a.rank < b.rank;
  };
  return info.reduce((best, cur) => (better(cur, best) ? cur : best)).index;
}

export function mapStemsToScore(stems: readonly NoteEvents[], options: NoteEventsMapOptions): NoteEventsDraft {
  const problems = checkStems(stems);
  if (problems.length > 0) throw new NoteEventsError('malformed', problems);

  const names = labelStems(stems);
  const order = stems.map((_, i) => i).sort((a, b) => PART_RANK[stems[a]!.instrument] - PART_RANK[stems[b]!.instrument] || a - b);

  // One grid: the best stem's beats, with the origin and any inferred tempo looking at every stem's notes.
  const lead = stems[pickGridStem(stems)]!;
  const allNotes = stems.flatMap((s) => s.notes).sort((a, b) => a.onset_s - b.onset_s || a.pitch - b.pitch);
  const grid: BeatGrid = beatGrid({ ...lead, notes: allNotes }, allNotes);
  const { capacity } = grid;

  const key = options.key ?? inferStemsKey(stems);
  const common: NoteEventsMapOptions = { id: options.id, key, ...(options.splitPoint === undefined ? {} : { splitPoint: options.splitPoint }) };

  // Pass 1: where each stem's notes fall. Pass 2 cuts every stem to the union of those spans.
  const spans = new Map<number, BarSpan>();
  for (const i of order) {
    if (stems[i]!.notes.length === 0) continue;
    const span = mapNoteEventsToScore(stems[i]!, { ...common, shared: { grid } }).span;
    if (span !== undefined) spans.set(i, span);
  }
  const nonEmpty = order.filter((i) => spans.has(i));
  const union = unionSpan([...spans.values()]);

  const diagnostics: string[] = [];
  for (const w of grid.warnings) diagnostics.push(`${w.code}: ${w.message}`);

  const shared: SharedGrid | undefined = union === null ? undefined : { grid, span: union };
  const mapped = new Map<number, NoteEventsDraft>();
  for (const i of nonEmpty) mapped.set(i, mapNoteEventsToScore(stems[i]!, { ...common, shared: shared! }));

  // The bar grid: the first mapped stem's (identical for every stem by construction), or one empty bar.
  const base = nonEmpty.length === 0 ? emptyBase(options) : mapped.get(nonEmpty[0]!)!.score;
  const bars: Bar[] = base.bars;
  const barLengths = bars.map((bar) => (bar.number === 0 && union !== null ? -union.pickupStart : capacity));

  const parts: Part[] = [];
  let staffCount = 0;
  order.forEach((i, k) => {
    const stem = stems[i]!;
    const label = names[i]!;
    const draft = mapped.get(i);
    const notes = (line: string): void => void diagnostics.push(`${label}: ${line}`);
    if (!NOTE_EVENTS_NOTATED.includes(stem.instrument)) {
      notes(`unsupported-instrument: ${stem.instrument} cannot be notated yet; imported as a single melody line (chords collapse to one note at a time), review it`);
    }
    let part: Part;
    if (draft === undefined) {
      notes('no-notes: the stem has no notes; kept as an empty part');
      for (const w of stem.warnings) notes(`${w.code}: ${w.message}${w.t_s == null ? '' : ` (at ${w.t_s}s)`}`);
      part = emptyPart(stem.instrument, bars, barLengths);
    } else {
      for (const line of draft.diagnostics) {
        // The grid's own warnings and the one-line inference are reported once, for the whole score.
        if (/^(no-beat-grid|no-downbeats|inferred):/.test(line)) continue;
        notes(line);
      }
      part = draft.score.parts[0]!;
    }
    parts.push(renumber(part, k + 1, label, stem.instrument, () => (staffCount += 1)));
  });

  diagnostics.push(`inferred: ${keyName(key)}, ${grid.time.beats}/${grid.time.beatValue}, about ${grid.tempoBpm} bpm, ${stems.length} stem${stems.length === 1 ? '' : 's'}`);

  const score: Score = {
    ...base,
    id: options.id,
    meta: {
      ...base.meta,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.composer === undefined ? {} : { composer: options.composer }),
      key,
      time: grid.time,
      layout: 'score',
    },
    bars,
    parts,
  };
  return { score, diagnostics };
}

const NOTE_EVENTS_NOTATED: readonly NoteEventsInstrument[] = ['voice', 'bass', 'drums', 'piano'];

/** `voice`, or `voice 2` for the second of an instrument: how a stem is named in a part and a diagnostic prefix. */
function labelStems(stems: readonly NoteEvents[]): string[] {
  const seen = new Map<NoteEventsInstrument, number>();
  const total = new Map<NoteEventsInstrument, number>();
  for (const s of stems) total.set(s.instrument, (total.get(s.instrument) ?? 0) + 1);
  return stems.map((s) => {
    const n = (seen.get(s.instrument) ?? 0) + 1;
    seen.set(s.instrument, n);
    return total.get(s.instrument)! > 1 && n > 1 ? `${s.instrument} ${n}` : s.instrument;
  });
}

function unionSpan(spans: readonly BarSpan[]): BarSpan | null {
  if (spans.length === 0) return null;
  const firstBar = Math.min(...spans.map((s) => s.firstBar));
  return {
    firstBar,
    lastBar: Math.max(...spans.map((s) => s.lastBar)),
    pickupStart: Math.min(...spans.filter((s) => s.firstBar === firstBar).map((s) => s.pickupStart)),
  };
}

/** The key over every pitched stem together, weighted by sounding time. */
function inferStemsKey(stems: readonly NoteEvents[]): KeySignature {
  const items: QuantizedItem[] = stems
    .filter((s) => s.instrument !== 'drums')
    .flatMap((s) => s.notes)
    .map((n) => ({
      kind: 'note',
      onset: 0,
      ticks: Math.max(1, Math.round((n.offset_s - n.onset_s) * 1000)),
      midi: n.pitch,
      confidence: n.confidence,
      sourceId: n.id,
      tiedFromPrevious: false,
      tiedToNext: false,
    }));
  return inferKey(items);
}

function keyName(key: KeySignature): string {
  return `${key.tonic}${key.alter === 1 ? '#' : key.alter === -1 ? 'b' : ''} ${key.mode}`;
}

/** A part under its final id, name and program, its staff ids made unique and its item ids prefixed by the part. */
function renumber(part: Part, number: number, label: string, instrument: NoteEventsInstrument, nextStaff: () => number): Part {
  const prefix = `p${number}-`;
  const named = label === instrument ? PART_NAME[instrument] : `${PART_NAME[instrument]} ${label.slice(instrument.length + 1)}`;
  return {
    ...part,
    id: `part-${number}`,
    name: named,
    instrument: PART_PROGRAM[instrument],
    transposition: 0,
    staves: part.staves.map((staff): Staff => ({
      ...staff,
      id: `staff-${nextStaff()}`,
      ...(instrument === 'bass' && staff.type === 'standard' ? { clef: 'bass' as Clef } : {}),
      bars: staff.bars.map((bar): StaffBar => ({
        ...bar,
        voices: bar.voices.map((voice) => ({ ...voice, items: voice.items.map((item) => prefixed(item, prefix)) })),
      })),
    })),
  };
}

function prefixed(item: BarItem, prefix: string): BarItem {
  const out = { ...item, id: `${prefix}${item.id}` } as BarItem;
  if ('stack' in out && out.stack !== undefined) out.stack = out.stack.map((s) => ({ ...s, id: `${prefix}${s.id}` }));
  return out;
}

/** A part with no notes: whole-bar rests in every bar of the shared grid. */
function emptyPart(instrument: NoteEventsInstrument, bars: readonly Bar[], lengths: readonly number[]): Part {
  const staffOf = (type: Staff['type'], clef: Clef): Staff => ({
    id: 'staff',
    type,
    clef,
    bars: bars.map((bar, index): StaffBar => {
      const items: BarItem[] = [];
      let at = 0;
      for (const duration of restPieces(0, lengths[index]!)) {
        items.push(makeRest({ id: `rest-${bar.number}-${items.length + 1}`, onset: at, duration }));
        at += durationTicks(duration);
      }
      return { barId: bar.id, voices: [{ index: 1, items, tuplets: [] }] };
    }),
  });
  const staves =
    instrument === 'drums'
      ? [staffOf('percussion', 'percussion')]
      : instrument === 'piano'
        ? [staffOf('standard', 'treble'), staffOf('standard', 'bass')]
        : [staffOf('standard', instrument === 'bass' ? 'bass' : 'treble')];
  return { id: 'part', name: '', instrument: null, transposition: 0, staves };
}

function emptyBase(options: NoteEventsMapOptions): Score {
  // No stem has a note: one empty bar, and the parts above are empty too. Built from the plain mapper's empty draft.
  const empty = mapNoteEventsToScore(
    { schema_version: 1, source: { sha256: '0'.repeat(64), duration_s: 0 }, instrument: 'voice', producer: { model_id: '', model_version: '', stage: 'transcribe' }, beats: [], notes: [], warnings: [] },
    { id: options.id },
  );
  return empty.score;
}
