/**
 * Score → MusicXML (V8b, ADR-0004).
 *
 * MusicXML is a codec at the edges and never the runtime truth. This writes a `score-partwise`
 * document for a single-voice lead sheet: the melody with its rests, ties and tuplets, chord
 * symbols as `<harmony>`, and the structure V7 added — rehearsal letters, repeat/double/final
 * barlines and 1st/2nd endings. What MusicXML has no place for is lost by design and named in a
 * test (`import.ts` lists the cases): the app's stable ids, a note's accidental *display* mode, the
 * `spellingPinned` and confidence/review flags, the style line, a section's free-text name, and any
 * chord text the grammar cannot parse.
 *
 * The chord round-trips **exactly** regardless, because the verbatim symbol rides along in the
 * `<kind text="…">` attribute — the structured `<root>`/`<kind>` is what a third-party app renders
 * from, the text attribute is what this codec reads back.
 */

import {
  DRUMS,
  NAV_SIGNS,
  NAV_TEXT,
  TICKS_PER_QUARTER,
  annotationsOfBar,
  barViews,
  clefAt,
  drumById,
  headOf,
  itemTicks,
  keyFifths,
  transposePitch,
  transposeSpelling,
  tupletOf,
  voiceIndexes,
  voiceSelects,
} from '@sibei/model';
import type {
  Annotation,
  BarItem,
  BarView,
  Chord,
  Clef,
  DrumId,
  Ending,
  GraceNote,
  Interval,
  NavKind,
  KeySignature,
  Note,
  NoteValue,
  Part,
  Rest,
  Score,
  Staff,
  StackedNote,
  Tempo,
  Tuplet,
} from '@sibei/model';
import { intervalOfSemitones, transposeElementValues } from './transposition.js';
import { parseChord } from '@sibei/music';
import type { ChordStructure, Root } from '@sibei/music';
import { elem, leaf, serialize } from './xml.js';
import type { XmlElement } from './xml.js';

/** `<divisions>` per quarter note. The model's tick already is this, so a duration maps 1:1. */
const DIVISIONS = TICKS_PER_QUARTER;

const NOTE_TYPE: Record<NoteValue, string> = {
  1: 'whole',
  2: 'half',
  4: 'quarter',
  8: 'eighth',
  16: '16th',
  32: '32nd',
};

const PROLOG = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
];

/** Serialise a score to a MusicXML `score-partwise` document. Deterministic. */
export function scoreToMusicXml(score: Score): string {
  const marks = slurMarks(score);
  const ottavas = ottavaMarks(score);
  const grid = barViews(score);
  const root = elem('score-partwise', { version: '4.0' }, [
    work(score),
    movementTitle(score),
    identification(score),
    partList(score),
    ...score.parts.map((part, index) => {
      const ctx = partContext(score, part, index);
      return elem(
        'part',
        { id: partId(index) },
        grid.map((bar, barIndex) => measure(score, ctx, bar, barIndex, grid[barIndex - 1], marks, ottavas)),
      );
    }),
  ]);
  return serialize(root, { prolog: PROLOG });
}

const partId = (index: number): string => `P${index + 1}`;

/**
 * What a part needs while its measures are written (ADR-0041 slice 5a): its staves, each staff's views per voice, and
 * the transposition it is written in. Voices are labelled `4 * staffIndex + voice`, so a second staff's voices are
 * 5-8 as MuseScore numbers them, and a single staff's voice 1 is `<voice>1</voice>`, as it always was.
 */
interface PartContext {
  part: Part;
  index: number;
  staves: { staff: Staff; percussion: boolean; voices: { index: number; label: number; views: BarView[] }[] }[];
  /** More than one staff: notes then carry `<staff>`, and the attributes `<staves>`. */
  multiStaff: boolean;
  /** The interval from sounding to written pitch, null for a concert part. */
  interval: Interval | null;
  /** The key signature the part is written in (the score's key moved by `interval`). */
  writtenKey: KeySignature;
}

function partContext(score: Score, part: Part, index: number): PartContext {
  const interval = part.transposition === 0 ? null : intervalOfSemitones(part.transposition);
  const key = score.meta.key;
  let writtenKey = key;
  if (interval !== null) {
    const tonic = transposeSpelling({ step: key.tonic, alter: key.alter }, interval, key, true);
    writtenKey = { tonic: tonic.step, alter: tonic.alter, mode: key.mode };
  }
  return {
    part,
    index,
    multiStaff: part.staves.length > 1,
    interval,
    writtenKey,
    staves: part.staves.map((staff, staffIndex) => ({
      staff,
      percussion: staff.type === 'percussion',
      voices: voiceIndexes(staff).map((voice) => ({
        index: voice,
        label: staffIndex * 4 + voice,
        views: barViews(score, { staff: staff.id, voice }),
      })),
    })),
  };
}

/** A fallback name for a part with none: the title for the first (as it always was), else `Part N`. */
export function exportedPartName(score: Score, part: Pick<Part, 'name'>, index: number): string {
  if (part.name !== '') return part.name;
  return index === 0 ? score.meta.title || 'Lead sheet' : `Part ${index + 1}`;
}

/**
 * `<part-list>`: a `<score-part>` per part (its name and, when it has one, the General MIDI program as a
 * `<midi-instrument>`; a part made only of percussion staves plays on channel 10). More than one part shares a
 * bracket, which is what the layout draws: the bracket is derived from the part count, not stored (ADR-0041 slice 3).
 */
function partList(score: Score): XmlElement {
  let channel = 0;
  const scoreParts = score.parts.map((part, index) => {
    const percussion = part.staves.length > 0 && part.staves.every((staff) => staff.type === 'percussion');
    const hasInstrument = part.instrument !== null || percussion;
    const id = `${partId(index)}-I1`;
    const name = exportedPartName(score, part, index);
    // `<part-abbreviation>` follows `<part-name>` in the schema (SIB2-286).
    const abbreviation = part.shortName === undefined ? null : leaf('part-abbreviation', part.shortName);
    // A drum kit names each drum it uses as an instrument of its own, with the General MIDI key it plays, so a note
    // can say which (`<instrument id>`) and a reader can map it (`<midi-unpitched>`, 1-based).
    const drums = drumsOfPart(part);
    if (drums.length > 0) {
      return elem('score-part', { id: partId(index) }, [
        leaf('part-name', name),
        abbreviation,
        ...drums.map((drum) => elem('score-instrument', { id: drumInstrumentId(index, drum) }, [leaf('instrument-name', drumById(drum).label)])),
        ...drums.map((drum) =>
          elem('midi-instrument', { id: drumInstrumentId(index, drum) }, [leaf('midi-channel', 10), leaf('midi-unpitched', drumById(drum).gm + 1)]),
        ),
      ]);
    }
    let midi: XmlElement | null = null;
    if (hasInstrument) {
      channel += 1;
      if (channel === 10) channel += 1; // channel 10 is percussion's
      midi = elem('midi-instrument', { id }, [
        leaf('midi-channel', percussion ? 10 : Math.min(channel, 16)),
        part.instrument === null ? null : leaf('midi-program', part.instrument + 1),
      ]);
    }
    return elem('score-part', { id: partId(index) }, [
      leaf('part-name', name),
      abbreviation,
      hasInstrument ? elem('score-instrument', { id }, [leaf('instrument-name', name)]) : null,
      midi,
    ]);
  });
  if (score.parts.length < 2) return elem('part-list', {}, scoreParts);
  return elem('part-list', {}, [
    elem('part-group', { type: 'start', number: 1 }, [leaf('group-symbol', 'bracket'), leaf('group-barline', 'yes')]),
    ...scoreParts,
    elem('part-group', { type: 'stop', number: 1 }),
  ]);
}

/** The drums a part's percussion staves use, in the order of the drum map (so the output is deterministic). */
function drumsOfPart(part: Part): DrumId[] {
  const used = new Set<DrumId>();
  for (const staff of part.staves) {
    if (staff.type !== 'percussion') continue;
    for (const bar of staff.bars) {
      for (const voice of bar.voices) {
        for (const item of voice.items) if (item.kind === 'note' && item.drum !== undefined) used.add(item.drum);
      }
    }
  }
  return DRUMS.filter((drum) => used.has(drum.id)).map((drum) => drum.id);
}

function drumInstrumentId(partIndex: number, drum: DrumId): string {
  return `${partId(partIndex)}-I${drumById(drum).gm}`;
}

function work(score: Score): XmlElement | null {
  return score.meta.title === '' ? null : elem('work', {}, [leaf('work-title', score.meta.title)]);
}

/** The subtitle is the movement title (SIB2-180); it sits between `<work>` and `<identification>`. */
function movementTitle(score: Score): XmlElement | null {
  return score.meta.subtitle === undefined ? null : leaf('movement-title', score.meta.subtitle);
}

function identification(score: Score): XmlElement {
  return elem('identification', {}, [
    // One creator per composer line; the arranger is a creator of its own type (SIB2-180).
    ...score.meta.composer
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => leaf('creator', line, { type: 'composer' })),
    score.meta.arranger === undefined ? null : leaf('creator', score.meta.arranger, { type: 'arranger' }),
    // The footer's text is the copyright line; which pages carry it has no MusicXML home (a named lossy case).
    score.meta.footer === undefined ? null : leaf('rights', score.meta.footer.text),
    elem('encoding', {}, [leaf('software', 'sibei-score'), leaf('encoding-date', '2020-01-01')]),
  ]);
}

// ---------------------------------------------------------------------------
// A measure
// ---------------------------------------------------------------------------

function measure(
  score: Score,
  ctx: PartContext,
  bar: BarView,
  barIndex: number,
  previous: BarView | undefined,
  slurs: SlurMarks,
  ottavas: OttavaMarks,
): XmlElement {
  const children: (XmlElement | null)[] = [];
  const isFirst = barIndex === 0;
  // Everything that belongs to the whole score rather than to one instrument (chords, text, rehearsal letters, the
  // tempo) is written once, in the first part: the chords ride above the top staff (ADR-0041 section 3).
  const lead = ctx.index === 0;

  // A line ends after the previous bar (SIB2-174), so this measure opens a new system. `join` and the
  // bars-per-line setting have no MusicXML form and are named lossy cases.
  if (previous?.lineBreak === 'after') children.push(elem('print', { 'new-system': 'yes' }));

  if (isFirst) children.push(attributes(score, ctx, bar));
  else {
    const changes = clefChanges(ctx, bar);
    if (changes.length > 0) children.push(elem('attributes', {}, changes));
  }

  const left = leftBarline(bar);
  if (left !== null) children.push(left);

  // The tempo mark (SIB2-177) opens the first measure: a metronome beat unit and `<sound tempo>` in quarter-note bpm.
  if (lead && isFirst && score.meta.tempo !== undefined) children.push(tempoDirection(score.meta.tempo));

  // A rehearsal letter for any section that begins on this bar. A section's free-text `name` has no
  // MusicXML home and is a named lossy case; its `letter` round-trips through `<rehearsal>`.
  for (const section of lead ? score.sections : []) {
    if (section.startBar === bar.number && section.letter !== null && section.letter !== '') {
      children.push(rehearsal(section.letter));
    }
  }

  // Navigation signs (SIB2-175) open the measure, above the staff; the jump texts close it, below.
  const signs = lead ? (bar.nav ?? []).filter((kind) => NAV_SIGNS.includes(kind)) : [];
  for (const kind of signs) children.push(navDirection(kind));

  // All harmonies at the top of the measure, each offset from the measure start to its onset. A
  // harmony carries no duration, so this places every chord at its beat without disturbing a note.
  for (const chord of lead ? [...bar.chords].sort((a, b) => a.onset - b.onset) : []) {
    children.push(harmony(chord));
  }

  // Text directions (SIB2-169) ride as `<words>` above the staff, offset to their beat like a harmony.
  for (const annotation of lead ? [...bar.annotations].sort((a, b) => a.onset - b.onset) : []) {
    children.push(words(annotation));
    // A dashed continuation line (SIB2-170) opens right after its words and closes in the end bar.
    if (annotation.lineEndBarId !== undefined && score.bars.some((b) => b.id === annotation.lineEndBarId)) {
      children.push(dashes('start', annotation.id, bar));
    }
  }
  for (const earlier of lead ? score.bars : []) {
    if (earlier.number > bar.number) continue;
    for (const annotation of annotationsOfBar(score, earlier.id)) {
      if (annotation.lineEndBarId === bar.id) children.push(dashes('stop', annotation.id, bar));
    }
  }

  // Each staff's voices in turn; a `<backup>` to the top of the measure starts every voice after the first. A gap
  // before a note is a `<forward>`, so onsets survive a read by something that lays notes end to end.
  let cursor = 0;
  for (const staffCtx of ctx.staves) {
    for (const voice of staffCtx.voices) {
      const view = voice.views[barIndex];
      if (view === undefined || view.items.length === 0) continue;
      if (cursor > 0) children.push(elem('backup', {}, [leaf('duration', cursor)]));
      const written = writtenView(view, ctx, staffCtx.percussion, score.meta.key);
      const staffNo = ctx.multiStaff ? ctx.staves.indexOf(staffCtx) + 1 : null;
      cursor = 0;
      for (const item of written.items) {
        if (item.onset > cursor) children.push(elem('forward', {}, [leaf('duration', item.onset - cursor)]));
        for (const el of itemElements(item, written, slurs, ottavas, {
          voice: voice.label,
          staff: staffNo,
          percussion: staffCtx.percussion,
          partIndex: ctx.index,
        })) {
          children.push(el);
        }
        cursor = Math.max(cursor, item.onset + itemTicks(item, written));
      }
    }
  }

  for (const kind of lead ? (bar.nav ?? []).filter((k) => !NAV_SIGNS.includes(k)) : []) children.push(navDirection(kind));

  const right = rightBarline(bar);
  if (right !== null) children.push(right);

  // A pickup is `implicit="yes"`: its bar number is 0 and it does not consume a numbered slot.
  const attrs = bar.number === 0 ? { number: '0', implicit: 'yes' } : { number: String(bar.number) };
  return elem('measure', attrs, children.filter((c): c is XmlElement => c !== null));
}

const BEAT_UNIT: Record<number, string> = { 1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth' };

function tempoDirection(tempo: Tempo): XmlElement {
  // `<sound tempo>` is quarter notes a minute, so a dotted or other unit is converted.
  const quarters = (tempo.bpm * (4 / tempo.unit.value) * (tempo.unit.dots === 1 ? 1.5 : 1));
  return elem('direction', { placement: 'above' }, [
    elem('direction-type', {}, [
      elem('metronome', {}, [
        leaf('beat-unit', BEAT_UNIT[tempo.unit.value] ?? 'quarter'),
        tempo.unit.dots === 1 ? elem('beat-unit-dot', {}) : null,
        leaf('per-minute', tempo.bpm),
      ]),
    ]),
    elem('sound', { tempo: Number(quarters.toFixed(2)) }),
  ]);
}

/**
 * One navigation mark (SIB2-175): the sign or the printed words, with the `<sound>` a player would follow. The
 * words carry the "al Coda" / "al Fine" part, which `<sound>` has no attribute for, so import reads both.
 */
function navDirection(kind: NavKind): XmlElement {
  const sound: Record<NavKind, Record<string, string>> = {
    segno: { segno: 'segno' },
    coda: { coda: 'coda' },
    'to-coda': { tocoda: 'coda' },
    fine: { fine: 'yes' },
    dc: { dacapo: 'yes' },
    'dc-al-fine': { dacapo: 'yes' },
    'dc-al-coda': { dacapo: 'yes' },
    ds: { dalsegno: 'segno' },
    'ds-al-fine': { dalsegno: 'segno' },
    'ds-al-coda': { dalsegno: 'segno' },
  };
  const type =
    kind === 'segno' ? elem('segno', {}) : kind === 'coda' ? elem('coda', {}) : leaf('words', NAV_TEXT[kind] ?? '');
  return elem('direction', { placement: 'above' }, [elem('direction-type', {}, [type]), elem('sound', sound[kind])]);
}

function rehearsal(letter: string): XmlElement {
  return elem('direction', { placement: 'above' }, [
    elem('direction-type', {}, [leaf('rehearsal', letter)]),
  ]);
}

/** The number pairs a start with its stop; the annotation's position in the whole score keeps it unique. */
function dashes(type: 'start' | 'stop', annotationId: string, _bar: BarView): XmlElement {
  const digits = (((Number(annotationId.replace(/\D/g, '')) || 1) - 1) % 16) + 1;
  return elem('direction', { placement: 'above' }, [
    elem('direction-type', {}, [elem('dashes', { type, number: digits })]),
  ]);
}

function words(annotation: Annotation): XmlElement {
  return elem('direction', { placement: 'above' }, [
    elem('direction-type', {}, [leaf('words', annotation.text)]),
    annotation.onset === 0 ? null : leaf('offset', annotation.onset),
  ]);
}

function attributes(score: Score, ctx: PartContext, bar: BarView): XmlElement {
  const key = ctx.writtenKey;
  const transpose = ctx.interval === null ? null : transposeElement(ctx.part.transposition);
  return elem('attributes', {}, [
    leaf('divisions', DIVISIONS),
    elem('key', {}, [leaf('fifths', keyFifths(key)), leaf('mode', key.mode)]),
    elem('time', {}, [leaf('beats', score.meta.time.beats), leaf('beat-type', score.meta.time.beatValue)]),
    ctx.multiStaff ? leaf('staves', ctx.staves.length) : null,
    // A part of two or more staves is a grand staff, which the layout braces (ADR-0041 slice 3).
    ctx.multiStaff ? leaf('part-symbol', 'brace') : null,
    ...ctx.staves.map(({ staff }, index) =>
      clefElement(clefAt(score, staff, bar.number), ctx.multiStaff ? index + 1 : null),
    ),
    transpose,
  ]);
}

/** Mid-score clef changes at this bar: a `<clef>` per staff that has one (`clef set s2.bar5`). */
function clefChanges(ctx: PartContext, bar: BarView): XmlElement[] {
  const out: XmlElement[] = [];
  ctx.staves.forEach(({ staff }, index) => {
    const change = staff.bars.find((staffBar) => staffBar.barId === bar.id)?.clef;
    if (change !== undefined) out.push(clefElement(change, ctx.multiStaff ? index + 1 : null));
  });
  return out;
}

const CLEF_SIGNS: Record<Clef, { sign: string; line?: number }> = {
  treble: { sign: 'G', line: 2 },
  bass: { sign: 'F', line: 4 },
  alto: { sign: 'C', line: 3 },
  tenor: { sign: 'C', line: 4 },
  percussion: { sign: 'percussion' },
};

function clefElement(clef: Clef, number: number | null): XmlElement {
  const { sign, line } = CLEF_SIGNS[clef];
  return elem('clef', number === null ? {} : { number }, [leaf('sign', sign), line === undefined ? null : leaf('line', line)]);
}

/** `<transpose>`: written to sounding, so a Bb trumpet (written a tone above concert) is diatonic -1, chromatic -2. */
function transposeElement(semitones: number): XmlElement {
  const values = transposeElementValues(semitones);
  return elem('transpose', {}, [
    leaf('diatonic', values.diatonic),
    leaf('chromatic', values.chromatic),
    values.octaveChange === 0 ? null : leaf('octave-change', values.octaveChange),
  ]);
}

/**
 * The view as it is written down: a transposing part's pitches (and its graces) move by the part's own interval,
 * spelled by that interval so the move is exactly reversible on import. A percussion staff's pitches are only
 * where its notes sit on the staff, so they never move.
 */
function writtenView(view: BarView, ctx: PartContext, percussion: boolean, concertKey: KeySignature): BarView {
  if (ctx.interval === null || percussion) return view;
  const interval = ctx.interval;
  const move = (pitch: Note['pitch']): Note['pitch'] => transposePitch(pitch, interval, concertKey, true);
  return {
    ...view,
    items: view.items.map((item) =>
      item.kind === 'note'
        ? {
            ...item,
            pitch: move(item.pitch),
            ...(item.stack === undefined ? {} : { stack: item.stack.map((tone) => ({ ...tone, pitch: move(tone.pitch) })) }),
            ...(item.graces === undefined ? {} : { graces: item.graces.map((grace) => ({ ...grace, pitch: move(grace.pitch) })) }),
          }
        : item,
    ),
  };
}

// ---------------------------------------------------------------------------
// Notes and rests
// ---------------------------------------------------------------------------

/** An ottava line's start before, or stop after, one note (SIB2-184): `<octave-shift>` in a `<direction>`. */
type OttavaMarks = Map<string, { starts: OttavaMark[]; stops: OttavaMark[] }>;

/** One `<octave-shift>` direction, numbered per staff when it is built so two staves' lines never share a number. */
type OttavaMark = (staff: number | null) => XmlElement;

function ottavaMarks(score: Score): OttavaMarks {
  const marks: OttavaMarks = new Map();
  const at = (id: string): { starts: OttavaMark[]; stops: OttavaMark[] } => {
    const found = marks.get(id) ?? { starts: [], stops: [] };
    marks.set(id, found);
    return found;
  };
  for (const line of score.spanners ?? []) {
    if (line.kind !== 'ottava' || line.octaveShift === undefined) continue;
    // MusicXML's `down` is a notes-printed-lower line, which is our 8va.
    const type = line.octaveShift === 'up' ? 'down' : 'up';
    const direction =
      (kind: string): OttavaMark =>
      (staff) =>
        elem('direction', { placement: line.octaveShift === 'up' ? 'above' : 'below' }, [
          elem('direction-type', {}, [elem('octave-shift', { type: kind, size: 8, number: staff ?? 1 })]),
          // A direction belongs to the staff the line is on, once there is more than one.
          staff === null ? null : leaf('staff', staff),
        ]);
    at(line.startId).starts.push(direction(type));
    at(line.endId).stops.push(direction('stop'));
  }
  return marks;
}

/** Where an item sits in its part: the voice label, the staff number when the part has several, drum notes. */
interface ItemContext {
  voice: number;
  staff: number | null;
  percussion: boolean;
  /** The part's index, to name a drum's instrument id. */
  partIndex: number;
}

function itemElements(item: BarItem, bar: BarView, slurs: SlurMarks, ottavas: OttavaMarks, at: ItemContext): XmlElement[] {
  if (item.kind !== 'note') return [restElement(item, bar, at)];
  const lines = ottavas.get(item.id);
  return [
    ...(lines?.starts ?? []).map((make) => make(at.staff)),
    // Grace notes come first, each a `<note><grace/>` with no duration (SIB2-185).
    ...(item.graces ?? []).map((grace) => graceElement(grace, at)),
    noteElement(item, bar, slurs.get(item.id) ?? [], at),
    // A stacked chord's other pitches follow as `<chord/>` notes: same duration, voice and staff, no marks (SIB2-243).
    ...(item.stack ?? []).map((tone) => noteElement(toneAsNote(item, tone), bar, [], at, item)),
    ...(lines?.stops ?? []).map((make) => make(at.staff)),
  ];
}

/** A slur's start or stop on one note, as `<slur type number placement>` wants it. */
interface SlurMark {
  type: 'start' | 'stop';
  number: number;
  placement?: 'above' | 'below';
}
type SlurMarks = Map<string, SlurMark[]>;

/**
 * Number each slur and say which notes carry its start and stop (SIB2-167). MusicXML pairs a stop with
 * its start by `number`, which only has to differ between slurs that overlap, so a slur takes the lowest
 * number no still-open slur holds. Reading order is the score's own: bars then items.
 */
function slurMarks(score: Score): SlurMarks {
  const marks: SlurMarks = new Map();
  const spanners = (score.spanners ?? []).filter((spanner) => spanner.kind === 'slur');
  if (spanners.length === 0) return marks;
  const order = new Map<string, number>();
  // Position in the score, across every staff and voice: bar first, then onset. A tie counts as overlapping, which
  // only ever costs a slur a higher number than it needed.
  for (const which of voiceSelects(score)) {
    barViews(score, which).forEach((view, barIndex) => {
      for (const item of view.items) order.set(item.id, barIndex * 1_000_000 + item.onset);
    });
  }
  const placed = spanners
    .map((spanner) => ({ spanner, from: order.get(spanner.startId), to: order.get(spanner.endId) }))
    .filter((p): p is { spanner: typeof p.spanner; from: number; to: number } => p.from !== undefined && p.to !== undefined)
    .sort((a, b) => a.from - b.from);
  const open: { to: number; number: number }[] = [];
  const push = (id: string, mark: SlurMark): void => {
    marks.set(id, [...(marks.get(id) ?? []), mark]);
  };
  for (const { spanner, from, to } of placed) {
    for (let i = open.length - 1; i >= 0; i -= 1) if ((open[i] as { to: number }).to < from) open.splice(i, 1);
    let number = 1;
    while (open.some((o) => o.number === number)) number += 1;
    open.push({ to, number });
    const placement = spanner.placement === undefined ? {} : { placement: spanner.placement };
    push(spanner.startId, { type: 'start', number, ...placement });
    push(spanner.endId, { type: 'stop', number });
  }
  return marks;
}

/**
 * One pitch of a stacked chord as the note it is written as: the stack member's own pitch, accidental and tie on the
 * carrying note's duration. Marks, fermata and graces belong to the first note of the chord, so they are left off.
 */
function toneAsNote(host: Note, tone: StackedNote): Note {
  const { articulations: _a, fermata: _f, graces: _g, stack: _s, ...bare } = host;
  return { ...bare, id: tone.id, pitch: tone.pitch, accidental: tone.accidental, tie: tone.tie, spellingPinned: tone.spellingPinned };
}

function noteElement(note: Note, bar: BarView, slurs: SlurMark[], at: ItemContext, chordOf?: Note): XmlElement {
  const owner = chordOf ?? note;
  const tuplet = tupletOf(owner.id, bar);
  const children: (XmlElement | null)[] = [
    chordOf === undefined ? null : elem('chord', {}),
    at.percussion ? unpitchedElement(note) : pitchElement(note),
    leaf('duration', itemTicks(owner, bar)),
    ...tieElements(note),
    // Which drum it strikes, as a score-instrument of the part (slice 6).
    at.percussion && note.drum !== undefined ? elem('instrument', { id: drumInstrumentId(at.partIndex, note.drum) }) : null,
    leaf('voice', at.voice),
    leaf('type', NOTE_TYPE[note.duration.value]),
    ...dots(note.duration.dots),
    // A drum note has no accidental to draw: its pitch is only where it sits on the staff.
    at.percussion ? null : accidentalElement(note),
    timeModification(tuplet),
    at.percussion ? noteheadElement(note) : null,
    at.staff === null ? null : leaf('staff', at.staff),
    notations(note, bar, tuplet, undefined, slurs, note.fermata === true),
  ];
  return elem('note', {}, children.filter((c): c is XmlElement => c !== null));
}

/** A grace note: `<grace slash="yes"/>` for an acciaccatura, no `<duration>`, a `<type>` for its flags. */
function graceElement(grace: GraceNote, at: ItemContext): XmlElement {
  return elem(
    'note',
    {},
    [
      elem('grace', grace.slashed ? { slash: 'yes' } : {}),
      at.percussion ? unpitchedElement(grace) : pitchElement(grace),
      leaf('voice', at.voice),
      leaf('type', NOTE_TYPE[grace.value]),
      at.percussion ? null : accidentalElement(grace),
      at.staff === null ? null : leaf('staff', at.staff),
    ].filter((c): c is XmlElement => c !== null),
  );
}

function restElement(rest: Rest, bar: BarView, at: ItemContext): XmlElement {
  const tuplet = tupletOf(rest.id, bar);
  return elem('note', {}, [
    elem('rest', {}),
    leaf('duration', itemTicks(rest, bar)),
    leaf('voice', at.voice),
    leaf('type', NOTE_TYPE[rest.duration.value]),
    ...dots(rest.duration.dots),
    timeModification(tuplet),
    at.staff === null ? null : leaf('staff', at.staff),
    notations(null, bar, tuplet, rest.id, [], rest.fermata === true),
  ].filter((c): c is XmlElement => c !== null));
}

/**
 * A percussion note: `<unpitched>` carries only where the note sits on the staff (its display pitch), since the model
 * has no drum noteheads or instrument map yet. The accidental, if any, is not written (a named lossy case).
 */
/**
 * `<notehead>` for a drum: the note's own head, or its drum's. Written when it is not an ordinary oval or when the note
 * overrides its drum's own, so a plain tom or snare stays as terse as it was.
 */
function noteheadElement(note: Note): XmlElement | null {
  if (note.drum === undefined && note.head === undefined) return null;
  const head = headOf(note);
  if (head === 'normal' && note.head === undefined) return null;
  return leaf('notehead', head);
}

function unpitchedElement(note: Pick<Note, 'pitch'>): XmlElement {
  return elem('unpitched', {}, [leaf('display-step', note.pitch.step), leaf('display-octave', note.pitch.octave)]);
}

function pitchElement(note: Pick<Note, 'pitch'>): XmlElement {
  return elem('pitch', {}, [
    leaf('step', note.pitch.step),
    note.pitch.alter === 0 ? null : leaf('alter', note.pitch.alter),
    leaf('octave', note.pitch.octave),
  ]);
}

/**
 * `<accidental>` is emitted only when a note is displaced and its display is not hidden. This is the
 * lossy edge: our `accidental` display ('auto'/'show'/'hide') has no MusicXML counterpart, so the
 * round-trip normalises it (`parens` is the exception: it is `parentheses="yes"` and survives) — the case is named in a test rather than pretended away.
 */
function accidentalElement(note: Pick<Note, 'pitch' | 'accidental'>): XmlElement | null {
  const parens = note.accidental === 'parens';
  if (note.accidental === 'hide' || (note.pitch.alter === 0 && !parens)) return null;
  // A parenthesised accidental is `parentheses="yes"` (SIB2-182), which survives; a cautionary natural
  // needs its own element since a natural has no alter.
  const name = note.pitch.alter === 0 ? 'natural' : ACCIDENTAL_NAME[note.pitch.alter];
  return name === undefined ? null : leaf('accidental', name, parens ? { parentheses: 'yes' } : {});
}

const ACCIDENTAL_NAME: Record<number, string> = {
  [-2]: 'flat-flat',
  [-1]: 'flat',
  [1]: 'sharp',
  [2]: 'double-sharp',
};

function dots(count: number): XmlElement[] {
  return Array.from({ length: count }, () => elem('dot', {}));
}

function tieElements(note: Note): XmlElement[] {
  const out: XmlElement[] = [];
  if (note.tie === 'stop' || note.tie === 'both') out.push(elem('tie', { type: 'stop' }));
  if (note.tie === 'start' || note.tie === 'both') out.push(elem('tie', { type: 'start' }));
  return out;
}

function timeModification(tuplet: Tuplet | null): XmlElement | null {
  if (tuplet === null) return null;
  return elem('time-modification', {}, [
    leaf('actual-notes', tuplet.actual),
    leaf('normal-notes', tuplet.normal),
  ]);
}

/** `<notations>` gathers the tie *notation* and the tuplet bracket. Null when there is nothing to say. */
function notations(
  note: Note | null,
  bar: BarView,
  tuplet: Tuplet | null,
  restId?: string,
  slurs: SlurMark[] = [],
  held = false,
): XmlElement | null {
  const parts: XmlElement[] = [];

  if (note !== null) {
    if (note.tie === 'stop' || note.tie === 'both') parts.push(elem('tied', { type: 'stop' }));
    if (note.tie === 'start' || note.tie === 'both') parts.push(elem('tied', { type: 'start' }));
    // Staccato, accent and marcato (SIB2-179). MusicXML's marcato is the strong accent.
    const marks = (note.articulations ?? []).map((mark) =>
      mark === 'staccato' ? elem('staccato', {}) : mark === 'accent' ? elem('accent', {}) : elem('strong-accent', { type: 'up' }),
    );
    if (marks.length > 0) parts.push(elem('articulations', {}, marks));
  }

  // `<fermata type="upright"/>` is the hold above the note or rest (SIB2-183).
  if (held) parts.push(elem('fermata', { type: 'upright' }));

  for (const slur of slurs) {
    parts.push(
      elem('slur', {
        type: slur.type,
        number: String(slur.number),
        ...(slur.placement === undefined ? {} : { placement: slur.placement }),
      }),
    );
  }

  if (tuplet !== null) {
    const id = note?.id ?? restId ?? '';
    const first = tuplet.memberIds[0] === id;
    const last = tuplet.memberIds[tuplet.memberIds.length - 1] === id;
    if (first) parts.push(elem('tuplet', { type: 'start' }));
    else if (last) parts.push(elem('tuplet', { type: 'stop' }));
  }

  return parts.length === 0 ? null : elem('notations', {}, parts);
}

// ---------------------------------------------------------------------------
// Harmony (chord symbols)
// ---------------------------------------------------------------------------

function harmony(chord: Chord): XmlElement {
  const parsed = parseChord(chord.text);
  const offset = chord.onset === 0 ? null : leaf('offset', chord.onset);

  if (parsed === null) {
    // Unparseable text: no root to give, so this is the lossy case. The verbatim symbol still rides
    // in the kind text so our own importer recovers it exactly; a third-party app may not render it.
    return elem('harmony', {}, [rootless(chord.text), offset]);
  }
  if (parsed.kind === 'no-chord') {
    return elem('harmony', {}, [leaf('kind', 'none', { text: chord.text }), offset]);
  }

  if (parsed.kind === 'alternate') {
    // MusicXML has no bracketed alternate: carry the verbatim text, as for any chord it cannot name.
    return elem('harmony', {}, [rootless(chord.text), offset]);
  }
  const s = parsed.structure;
  return elem('harmony', {}, [
    rootElement('root', s.root),
    leaf('kind', kindOf(s), { text: chord.text }),
    s.bass === null ? null : rootElement('bass', s.bass),
    ...s.alterations.map((a) =>
      elem('degree', {}, [
        leaf('degree-value', a.degree),
        leaf('degree-alter', a.alter),
        leaf('degree-type', 'alter'),
      ]),
    ),
    offset,
  ]);
}

function rootless(text: string): XmlElement {
  return elem('kind', { text }, ['other']);
}

function rootElement(tag: 'root' | 'bass', root: Root): XmlElement {
  return elem(tag, {}, [
    leaf(`${tag}-step`, root.step),
    root.alter === 0 ? null : leaf(`${tag}-alter`, root.alter),
  ]);
}

/**
 * A best-effort MusicXML `<kind>` keyword for third-party rendering. The codec's own round-trip does
 * not depend on it — the verbatim symbol is in the `text` attribute — so an imperfect keyword only
 * affects how another app draws the chord, never what this one reads back.
 */
function kindOf(s: ChordStructure): string {
  if (s.power) return 'power';
  if (s.suspension === 'sus2') return 'suspended-second';
  if (s.suspension === 'sus4') return 'suspended-fourth';

  const ext = s.extension === 9 ? 'ninth' : s.extension === 11 ? '11th' : s.extension === 13 ? '13th' : null;

  switch (s.triad) {
    case 'major':
      if (s.seventh === 'major') return ext === null ? 'major-seventh' : `major-${ext}`;
      if (s.seventh === 'minor') return ext === null ? 'dominant' : `dominant-${ext}`;
      if (s.sixth) return 'major-sixth';
      return 'major';
    case 'minor':
      if (s.seventh === 'minor') return ext === null ? 'minor-seventh' : `minor-${ext}`;
      if (s.seventh === 'major') return 'major-minor';
      if (s.sixth) return 'minor-sixth';
      return 'minor';
    case 'diminished':
      if (s.seventh === 'diminished') return 'diminished-seventh';
      if (s.seventh === 'minor') return 'half-diminished';
      return 'diminished';
    case 'augmented':
      if (s.seventh === 'minor') return 'augmented-seventh';
      return 'augmented';
  }
}

// ---------------------------------------------------------------------------
// Barlines and endings
// ---------------------------------------------------------------------------

function leftBarline(bar: BarView): XmlElement | null {
  const parts: XmlElement[] = [];
  if (bar.startBarline === 'repeat-start') {
    parts.push(leaf('bar-style', 'heavy-light'), elem('repeat', { direction: 'forward' }));
  }
  const startEnding = endingElement(bar.ending, 'left');
  if (startEnding !== null) parts.unshift(startEnding);
  return parts.length === 0 ? null : elem('barline', { location: 'left' }, parts);
}

function rightBarline(bar: BarView): XmlElement | null {
  const parts: XmlElement[] = [];
  const style = END_BAR_STYLE[bar.endBarline];
  if (style !== null) parts.push(leaf('bar-style', style));
  if (bar.endBarline === 'repeat-end') parts.push(elem('repeat', { direction: 'backward' }));
  const stopEnding = endingElement(bar.ending, 'right');
  if (stopEnding !== null) parts.push(stopEnding);
  return parts.length === 0 ? null : elem('barline', { location: 'right' }, parts);
}

const END_BAR_STYLE: Record<BarView['endBarline'], string | null> = {
  single: null,
  double: 'light-light',
  final: 'light-heavy',
  'repeat-end': 'light-heavy',
};

/**
 * An `<ending>` for one side of a bar. MusicXML puts the bracket's opening on the left barline and
 * its close on the right, so a `start` shows on the left and a `stop` on the right; `start-stop`
 * shows on both, and a `continue` bar carries neither (it is a middle bar, recovered on import from
 * lying between a start and a stop).
 */
function endingElement(ending: Ending | null, side: 'left' | 'right'): XmlElement | null {
  if (ending === null) return null;
  const numbers = ending.numbers.join(', ');
  const opens = ending.role === 'start' || ending.role === 'start-stop';
  const closes = ending.role === 'stop' || ending.role === 'start-stop';
  if (side === 'left' && opens) return elem('ending', { number: numbers, type: 'start' });
  if (side === 'right' && closes) return elem('ending', { number: numbers, type: 'stop' });
  return null;
}
