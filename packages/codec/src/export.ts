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

import { TICKS_PER_QUARTER, itemTicks, keyFifths, tupletOf } from '@sibei/model';
import type {
  Bar,
  Chord,
  Ending,
  Note,
  NoteValue,
  Rest,
  Score,
  Tuplet,
} from '@sibei/model';
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
  const root = elem('score-partwise', { version: '4.0' }, [
    work(score),
    identification(score),
    elem('part-list', {}, [
      elem('score-part', { id: 'P1' }, [leaf('part-name', score.meta.title || 'Lead sheet')]),
    ]),
    elem(
      'part',
      { id: 'P1' },
      score.bars.map((bar, index) => measure(score, bar, index === 0)),
    ),
  ]);
  return serialize(root, { prolog: PROLOG });
}

function work(score: Score): XmlElement | null {
  return score.meta.title === '' ? null : elem('work', {}, [leaf('work-title', score.meta.title)]);
}

function identification(score: Score): XmlElement {
  return elem('identification', {}, [
    score.meta.composer === '' ? null : leaf('creator', score.meta.composer, { type: 'composer' }),
    elem('encoding', {}, [leaf('software', 'sibei-score'), leaf('encoding-date', '2020-01-01')]),
  ]);
}

// ---------------------------------------------------------------------------
// A measure
// ---------------------------------------------------------------------------

function measure(score: Score, bar: Bar, isFirst: boolean): XmlElement {
  const children: (XmlElement | null)[] = [];

  if (isFirst) children.push(attributes(score));

  const left = leftBarline(bar);
  if (left !== null) children.push(left);

  // A rehearsal letter for any section that begins on this bar. A section's free-text `name` has no
  // MusicXML home and is a named lossy case; its `letter` round-trips through `<rehearsal>`.
  for (const section of score.sections) {
    if (section.startBar === bar.number && section.letter !== null && section.letter !== '') {
      children.push(rehearsal(section.letter));
    }
  }

  // All harmonies at the top of the measure, each offset from the measure start to its onset. A
  // harmony carries no duration, so this places every chord at its beat without disturbing a note.
  for (const chord of [...bar.chords].sort((a, b) => a.onset - b.onset)) {
    children.push(harmony(chord));
  }

  for (const note of noteElements(bar)) children.push(note);

  const right = rightBarline(bar);
  if (right !== null) children.push(right);

  // A pickup is `implicit="yes"`: its bar number is 0 and it does not consume a numbered slot.
  const attrs = bar.number === 0 ? { number: '0', implicit: 'yes' } : { number: String(bar.number) };
  return elem('measure', attrs, children.filter((c): c is XmlElement => c !== null));
}

function rehearsal(letter: string): XmlElement {
  return elem('direction', { placement: 'above' }, [
    elem('direction-type', {}, [leaf('rehearsal', letter)]),
  ]);
}

function attributes(score: Score): XmlElement {
  const key = score.meta.key;
  return elem('attributes', {}, [
    leaf('divisions', DIVISIONS),
    elem('key', {}, [leaf('fifths', keyFifths(key)), leaf('mode', key.mode)]),
    elem('time', {}, [leaf('beats', score.meta.time.beats), leaf('beat-type', score.meta.time.beatValue)]),
    elem('clef', {}, [leaf('sign', 'G'), leaf('line', 2)]),
  ]);
}

// ---------------------------------------------------------------------------
// Notes and rests
// ---------------------------------------------------------------------------

function noteElements(bar: Bar): XmlElement[] {
  return bar.items.map((item) => (item.kind === 'note' ? noteElement(item, bar) : restElement(item, bar)));
}

function noteElement(note: Note, bar: Bar): XmlElement {
  const tuplet = tupletOf(note.id, bar);
  const children: (XmlElement | null)[] = [
    pitchElement(note),
    leaf('duration', itemTicks(note, bar)),
    ...tieElements(note),
    leaf('voice', 1),
    leaf('type', NOTE_TYPE[note.duration.value]),
    ...dots(note.duration.dots),
    accidentalElement(note),
    timeModification(tuplet),
    notations(note, bar, tuplet),
  ];
  return elem('note', {}, children.filter((c): c is XmlElement => c !== null));
}

function restElement(rest: Rest, bar: Bar): XmlElement {
  const tuplet = tupletOf(rest.id, bar);
  return elem('note', {}, [
    elem('rest', {}),
    leaf('duration', itemTicks(rest, bar)),
    leaf('voice', 1),
    leaf('type', NOTE_TYPE[rest.duration.value]),
    ...dots(rest.duration.dots),
    timeModification(tuplet),
    notations(null, bar, tuplet, rest.id),
  ].filter((c): c is XmlElement => c !== null));
}

function pitchElement(note: Note): XmlElement {
  return elem('pitch', {}, [
    leaf('step', note.pitch.step),
    note.pitch.alter === 0 ? null : leaf('alter', note.pitch.alter),
    leaf('octave', note.pitch.octave),
  ]);
}

/**
 * `<accidental>` is emitted only when a note is displaced and its display is not hidden. This is the
 * lossy edge: our three-way `accidental` ('auto'/'show'/'hide') has no MusicXML counterpart, so the
 * round-trip normalises it — the case is named in a test rather than pretended away.
 */
function accidentalElement(note: Note): XmlElement | null {
  if (note.accidental === 'hide' || note.pitch.alter === 0) return null;
  const name = ACCIDENTAL_NAME[note.pitch.alter];
  return name === undefined ? null : leaf('accidental', name);
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
  bar: Bar,
  tuplet: Tuplet | null,
  restId?: string,
): XmlElement | null {
  const parts: XmlElement[] = [];

  if (note !== null) {
    if (note.tie === 'stop' || note.tie === 'both') parts.push(elem('tied', { type: 'stop' }));
    if (note.tie === 'start' || note.tie === 'both') parts.push(elem('tied', { type: 'start' }));
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

  const s = parsed.structure;
  return elem('harmony', {}, [
    rootElement('root', s.root),
    leaf('kind', kindOf(s), { text: chord.text }),
    s.bass === null ? null : rootElement('bass', s.bass),
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

function leftBarline(bar: Bar): XmlElement | null {
  const parts: XmlElement[] = [];
  if (bar.startBarline === 'repeat-start') {
    parts.push(leaf('bar-style', 'heavy-light'), elem('repeat', { direction: 'forward' }));
  }
  const startEnding = endingElement(bar.ending, 'left');
  if (startEnding !== null) parts.unshift(startEnding);
  return parts.length === 0 ? null : elem('barline', { location: 'left' }, parts);
}

function rightBarline(bar: Bar): XmlElement | null {
  const parts: XmlElement[] = [];
  const style = END_BAR_STYLE[bar.endBarline];
  if (style !== null) parts.push(leaf('bar-style', style));
  if (bar.endBarline === 'repeat-end') parts.push(elem('repeat', { direction: 'backward' }));
  const stopEnding = endingElement(bar.ending, 'right');
  if (stopEnding !== null) parts.push(stopEnding);
  return parts.length === 0 ? null : elem('barline', { location: 'right' }, parts);
}

const END_BAR_STYLE: Record<Bar['endBarline'], string | null> = {
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
