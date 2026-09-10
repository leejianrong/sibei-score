/**
 * MusicXML → Score (V8b, ADR-0004).
 *
 * The reverse of `export.ts`, for a single-voice lead sheet. It reads `score-partwise`: the first
 * part's measures become bars; `<note>`s become notes and rests with their ties and tuplets;
 * `<harmony>` becomes chord symbols; `<barline>`, `<ending>` and `<rehearsal>` become the structure
 * V7 added. What MusicXML never carried is minted fresh or defaulted — new ids, `accidental: 'auto'`,
 * `spellingPinned: false`, no confidence or review, no style line — which is the round-trip's lossy
 * half, named case by case in `tests`.
 *
 * **Read leniently** (the codec's half of ADR-0012's rule): a second voice, an unsupported note
 * type, or a key change mid-piece is dropped with a warning rather than refused, because an imported
 * document is not the place to be strict — the model stores and flags, it does not reject.
 */

import { makeBar, makeChord, makeNote, makeRest, makeScore, makeSection } from '@sibei/model';
import type {
  Alter,
  BarItem,
  Ending,
  EndingRole,
  KeySignature,
  Mode,
  NoteValue,
  Score,
  Section,
  Step,
  TieRole,
  Tuplet,
} from '@sibei/model';
import {
  attr,
  childElements,
  childText,
  firstChild,
  parseXml,
  textContent,
  XmlError,
} from './xml.js';
import type { XmlElement } from './xml.js';

const TICKS_PER_QUARTER = 480;

export interface ImportResult {
  score: Score;
  /** MusicXML this codec met but could not keep — a second voice, a mid-piece key change, and such. */
  warnings: string[];
}

/** A document this codec cannot read at all (not well-formed, or not a single-voice lead sheet). */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ImportOptions {
  /** The id to give the imported score. Ids do not survive MusicXML (ADR-0004), so this is minted. */
  id?: string;
}

export function musicXmlToScore(xml: string, options: ImportOptions = {}): ImportResult {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (error) {
    throw new ImportError(error instanceof XmlError ? error.message : 'the document is not valid XML');
  }

  if (root.name === 'score-timewise') {
    throw new ImportError('score-timewise is not supported; convert to score-partwise first');
  }
  if (root.name !== 'score-partwise') {
    throw new ImportError(`expected a <score-partwise> document, found <${root.name}>`);
  }

  const warnings: string[] = [];
  const title = childText(firstChild(root, 'work') ?? root, 'work-title') ?? '';
  const composer = composerOf(root);

  const part = firstChild(root, 'part');
  if (part === null) throw new ImportError('the document has no <part>');

  const measures = childElements(part, 'measure');
  if (measures.length === 0) throw new ImportError('the part has no <measure>');

  const reader = new PartReader(warnings);
  const { bars, sections, key, time } = reader.read(measures);

  const score = makeScore({
    id: options.id ?? 'imported',
    title,
    composer,
    key,
    time,
    bars,
    sections,
  });
  return { score, warnings };
}

function composerOf(root: XmlElement): string {
  const identification = firstChild(root, 'identification');
  if (identification === null) return '';
  for (const creator of childElements(identification, 'creator')) {
    if (attr(creator, 'type') === 'composer') return textContent(creator);
  }
  return '';
}

// ---------------------------------------------------------------------------
// The part reader
// ---------------------------------------------------------------------------

interface ReadResult {
  bars: ReturnType<typeof makeBar>[];
  sections: Section[];
  key: KeySignature;
  time: { beats: number; beatValue: NoteValue };
}

/** A tuplet being accumulated across consecutive time-modified notes. */
interface OpenTuplet {
  actual: number;
  normal: number;
  memberIds: string[];
}

class PartReader {
  private ids = 0;
  private divisions = TICKS_PER_QUARTER;
  private key: KeySignature = { tonic: 'C', alter: 0, mode: 'major' };
  private time: { beats: number; beatValue: NoteValue } = { beats: 4, beatValue: 4 };
  private sawAttributes = false;
  /** An ending open on an earlier bar, so a bar between its start and stop reads as `continue`. */
  private openEnding: number[] | null = null;

  constructor(private readonly warnings: string[]) {}

  private id(prefix: string): string {
    this.ids += 1;
    return `${prefix}-${this.ids}`;
  }

  read(measures: XmlElement[]): ReadResult {
    const bars: ReturnType<typeof makeBar>[] = [];
    const sections: Section[] = [];

    measures.forEach((measure, index) => {
      const bar = this.readMeasure(measure, index, sections);
      bars.push(bar);
    });

    return { bars, sections, key: this.key, time: this.time };
  }

  private readMeasure(measure: XmlElement, index: number, sections: Section[]): ReturnType<typeof makeBar> {
    const number = this.barNumber(measure, index);
    const items: BarItem[] = [];
    const tuplets: Tuplet[] = [];
    const chords: { id: string; onset: number; text: string }[] = [];

    let cursor = 0;
    let openTuplet: OpenTuplet | null = null;
    let startBarline: 'none' | 'repeat-start' = 'none';
    let endBarline: 'single' | 'double' | 'final' | 'repeat-end' = 'single';
    let hasStart = false;
    let hasStop = false;
    let endingNumbers: number[] | null = null;
    let voiceEnded = false;

    const closeTuplet = (): void => {
      if (openTuplet !== null) {
        tuplets.push({ id: this.id('tuplet'), ...openTuplet });
        openTuplet = null;
      }
    };

    for (const child of childElements(measure)) {
      switch (child.name) {
        case 'attributes':
          this.readAttributes(child);
          break;

        case 'note': {
          if (voiceEnded) break;
          if (firstChild(child, 'chord') !== null) {
            // A second note at the same onset: single-voice keeps the first (ADR-0021, the layout
            // engine's single-voice assumption), and this is dropped rather than refused.
            this.note('a chord note (a second simultaneous pitch) was dropped: single-voice only');
            break;
          }
          const parsed = this.readNote(child, cursor);
          items.push(parsed.item);
          openTuplet = this.trackTuplet(openTuplet, tuplets, parsed);
          cursor += parsed.ticks;
          break;
        }

        case 'forward':
          if (!voiceEnded) cursor += this.ticksOf(child);
          break;

        case 'backup':
          // A rewind means a second voice starts here. Keep the first, drop the rest of this bar.
          voiceEnded = true;
          this.note('a second voice was dropped: single-voice only');
          break;

        case 'harmony': {
          const chord = this.readHarmony(child, cursor);
          if (chord !== null) chords.push(chord);
          break;
        }

        case 'direction': {
          const letter = this.rehearsalOf(child);
          if (letter !== null && !sections.some((s) => s.startBar === number)) {
            sections.push(makeSection({ id: this.id('section'), startBar: number, letter }));
          }
          break;
        }

        case 'barline': {
          const read = this.readBarline(child);
          if (read.start !== null) startBarline = read.start;
          if (read.end !== null) endBarline = read.end;
          if (read.endingStart !== null) {
            hasStart = true;
            endingNumbers = read.endingStart;
          }
          if (read.endingStop !== null) {
            hasStop = true;
            endingNumbers = endingNumbers ?? read.endingStop;
          }
          break;
        }

        default:
          break;
      }
    }
    closeTuplet();

    const ending = this.resolveEnding(hasStart, hasStop, endingNumbers);

    return makeBar({
      id: this.id('bar'),
      number,
      items,
      tuplets,
      chords: chords.map((c) => makeChord(c)),
      startBarline,
      endBarline,
      ending,
    });
  }

  private barNumber(measure: XmlElement, index: number): number {
    if (attr(measure, 'implicit') === 'yes') return 0;
    const raw = attr(measure, 'number');
    if (raw !== null && /^-?\d+$/.test(raw)) return Number(raw);
    // A non-numeric label (some publishers use "X1"): fall back to position, pickup-aware.
    return index;
  }

  private readAttributes(el: XmlElement): void {
    const divisions = childText(el, 'divisions');
    if (divisions !== null && Number(divisions) > 0) this.divisions = Number(divisions);

    const key = firstChild(el, 'key');
    const time = firstChild(el, 'time');

    if (!this.sawAttributes) {
      if (key !== null) this.key = keyFromFifths(Number(childText(key, 'fifths') ?? 0), modeOf(key));
      if (time !== null) this.time = timeFrom(time);
      this.sawAttributes = true;
    } else if ((key !== null || time !== null) && this.divisionsChanged(key, time)) {
      // One time signature per chart in both milestones (ADR-0021/Q34); a later change is dropped.
      this.note('a mid-piece key or time change was dropped: one key and meter per chart');
    }
  }

  private divisionsChanged(key: XmlElement | null, time: XmlElement | null): boolean {
    if (time !== null) {
      const t = timeFrom(time);
      if (t.beats !== this.time.beats || t.beatValue !== this.time.beatValue) return true;
    }
    if (key !== null) {
      const k = keyFromFifths(Number(childText(key, 'fifths') ?? 0), modeOf(key));
      if (k.tonic !== this.key.tonic || k.alter !== this.key.alter || k.mode !== this.key.mode) return true;
    }
    return false;
  }

  private readNote(el: XmlElement, onset: number): {
    item: BarItem;
    ticks: number;
    tuplet: { actual: number; normal: number } | null;
  } {
    const ticks = this.ticksOf(el);
    const { value, dots } = this.durationOf(el, ticks);
    const timeMod = firstChild(el, 'time-modification');
    const tuplet =
      timeMod === null
        ? null
        : {
            actual: Number(childText(timeMod, 'actual-notes') ?? 1),
            normal: Number(childText(timeMod, 'normal-notes') ?? 1),
          };

    if (firstChild(el, 'rest') !== null) {
      return { item: makeRest({ id: this.id('rest'), onset, duration: { value, dots } }), ticks, tuplet };
    }

    const pitch = firstChild(el, 'pitch');
    if (pitch === null) {
      // Neither a rest nor a pitch: treat as a rest so the bar's timing survives.
      this.note('a note with no pitch was read as a rest');
      return { item: makeRest({ id: this.id('rest'), onset, duration: { value, dots } }), ticks, tuplet };
    }

    const step = (childText(pitch, 'step') ?? 'C') as Step;
    const alter = clampAlter(Number(childText(pitch, 'alter') ?? 0));
    const octave = Number(childText(pitch, 'octave') ?? 4);

    return {
      item: makeNote({
        id: this.id('note'),
        onset,
        duration: { value, dots },
        pitch: { step, alter, octave },
        tie: tieOf(el),
      }),
      ticks,
      tuplet,
    };
  }

  /** Grow, close and open tuplet runs. Consecutive members of one ratio form one Tuplet. */
  private trackTuplet(
    open: OpenTuplet | null,
    tuplets: Tuplet[],
    parsed: { item: BarItem; tuplet: { actual: number; normal: number } | null },
  ): OpenTuplet | null {
    const tm = parsed.tuplet;
    if (tm === null) {
      if (open !== null) tuplets.push({ id: this.id('tuplet'), ...open });
      return null;
    }
    if (open !== null && (open.actual !== tm.actual || open.normal !== tm.normal)) {
      tuplets.push({ id: this.id('tuplet'), ...open });
      open = null;
    }
    const next = open ?? { actual: tm.actual, normal: tm.normal, memberIds: [] };
    next.memberIds.push(parsed.item.id);
    return next;
  }

  private readHarmony(el: XmlElement, cursor: number): { id: string; onset: number; text: string } | null {
    const offset = childText(el, 'offset');
    const onset = cursor + (offset === null ? 0 : this.scale(Number(offset)));
    const text = this.harmonyText(el);
    if (text === null) return null;
    return { id: this.id('chord'), onset, text };
  }

  /** The verbatim symbol from the `<kind text>` this codec wrote, or a best-effort reconstruction. */
  private harmonyText(el: XmlElement): string | null {
    const kind = firstChild(el, 'kind');
    if (kind === null) return null;
    const text = attr(kind, 'text');
    if (text !== null && text !== '') return text;

    // A third-party harmony with no display text: rebuild from root + kind keyword.
    const kindValue = textContent(kind);
    if (kindValue === 'none') return 'N.C.';
    const root = firstChild(el, 'root');
    if (root === null) return null;
    const rootText = `${childText(root, 'root-step') ?? ''}${alterMark(Number(childText(root, 'root-alter') ?? 0))}`;
    const bass = firstChild(el, 'bass');
    const bassText =
      bass === null ? '' : `/${childText(bass, 'bass-step') ?? ''}${alterMark(Number(childText(bass, 'bass-alter') ?? 0))}`;
    return `${rootText}${KIND_SUFFIX[kindValue] ?? ''}${bassText}`;
  }

  private rehearsalOf(direction: XmlElement): string | null {
    for (const type of childElements(direction, 'direction-type')) {
      const rehearsal = firstChild(type, 'rehearsal');
      if (rehearsal !== null) {
        const text = textContent(rehearsal);
        if (text !== '') return text;
      }
    }
    return null;
  }

  private readBarline(el: XmlElement): {
    start: 'none' | 'repeat-start' | null;
    end: 'single' | 'double' | 'final' | 'repeat-end' | null;
    endingStart: number[] | null;
    endingStop: number[] | null;
  } {
    const style = childText(el, 'bar-style');
    const repeat = firstChild(el, 'repeat');
    const direction = repeat === null ? null : attr(repeat, 'direction');

    let start: 'none' | 'repeat-start' | null = null;
    let end: 'single' | 'double' | 'final' | 'repeat-end' | null = null;
    if (direction === 'forward') start = 'repeat-start';
    else if (direction === 'backward') end = 'repeat-end';
    else if (style === 'light-light') end = 'double';
    else if (style === 'light-heavy') end = 'final';

    let endingStart: number[] | null = null;
    let endingStop: number[] | null = null;
    const ending = firstChild(el, 'ending');
    if (ending !== null) {
      const numbers = numbersOf(attr(ending, 'number'));
      const type = attr(ending, 'type');
      if (type === 'start') endingStart = numbers;
      else if (type === 'stop' || type === 'discontinue') endingStop = numbers;
    }

    return { start, end, endingStart, endingStop };
  }

  private resolveEnding(hasStart: boolean, hasStop: boolean, numbers: number[] | null): Ending | null {
    let role: EndingRole | 'continue-or-none' = 'continue-or-none';
    if (hasStart && hasStop) role = 'start-stop';
    else if (hasStart) role = 'start';
    else if (hasStop) role = 'stop';

    // `start` opens a bracket that later bars continue; `start-stop` opens and closes on this one,
    // so it leaves nothing open — the bug that made every bar after a single-bar ending read as
    // `continue`. `stop` closes an open bracket.
    if (role === 'start') this.openEnding = numbers;
    else if (role === 'stop' || role === 'start-stop') this.openEnding = null;

    if (role === 'continue-or-none') {
      if (this.openEnding === null) return null;
      return { numbers: this.openEnding, role: 'continue' };
    }
    return { numbers: numbers ?? [], role };
  }

  private ticksOf(el: XmlElement): number {
    const duration = childText(el, 'duration');
    return duration === null ? 0 : this.scale(Number(duration));
  }

  private scale(divisions: number): number {
    return Math.round((divisions * TICKS_PER_QUARTER) / this.divisions);
  }

  /** The written value and dots: from `<type>`/`<dot>` when present, else derived from the ticks. */
  private durationOf(el: XmlElement, ticks: number): { value: NoteValue; dots: 0 | 1 | 2 } {
    const type = childText(el, 'type');
    const dots = Math.min(childElements(el, 'dot').length, 2) as 0 | 1 | 2;
    if (type !== null && VALUE_OF_TYPE[type] !== undefined) {
      return { value: VALUE_OF_TYPE[type], dots };
    }
    if (type !== null) this.note(`an unsupported note type "${type}" was read by its duration`);
    return deriveDuration(ticks);
  }

  private note(warning: string): void {
    if (!this.warnings.includes(warning)) this.warnings.push(warning);
  }
}

// ---------------------------------------------------------------------------
// Small pure mappings
// ---------------------------------------------------------------------------

const VALUE_OF_TYPE: Record<string, NoteValue> = {
  whole: 1,
  half: 2,
  quarter: 4,
  eighth: 8,
  '16th': 16,
  '32nd': 32,
};

/** A best-effort value/dots for a plain (untupled) tick length, when `<type>` is missing. */
function deriveDuration(ticks: number): { value: NoteValue; dots: 0 | 1 | 2 } {
  const whole = TICKS_PER_QUARTER * 4;
  for (const value of [1, 2, 4, 8, 16, 32] as NoteValue[]) {
    const base = whole / value;
    for (const dots of [0, 1, 2] as const) {
      const withDots = (base * (2 ** (dots + 1) - 1)) / 2 ** dots;
      if (withDots === ticks) return { value, dots };
    }
  }
  return { value: 4, dots: 0 };
}

function tieOf(el: XmlElement): TieRole {
  let start = false;
  let stop = false;
  for (const tie of childElements(el, 'tie')) {
    if (attr(tie, 'type') === 'start') start = true;
    if (attr(tie, 'type') === 'stop') stop = true;
  }
  if (start && stop) return 'both';
  if (start) return 'start';
  if (stop) return 'stop';
  return 'none';
}

function modeOf(key: XmlElement): Mode {
  return childText(key, 'mode') === 'minor' ? 'minor' : 'major';
}

function timeFrom(time: XmlElement): { beats: number; beatValue: NoteValue } {
  const beats = Number(childText(time, 'beats') ?? 4);
  const beatValue = (VALUE_OF_TYPE[childText(time, 'beat-type') ?? '4'] ?? Number(childText(time, 'beat-type') ?? 4)) as NoteValue;
  return { beats, beatValue };
}

function clampAlter(value: number): Alter {
  const rounded = Math.round(value);
  return (rounded < -2 ? -2 : rounded > 2 ? 2 : rounded) as Alter;
}

function numbersOf(raw: string | null): number[] {
  if (raw === null) return [];
  return raw
    .split(/[,\s]+/)
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n));
}

function alterMark(alter: number): string {
  if (alter <= -2) return 'bb';
  if (alter === -1) return 'b';
  if (alter === 1) return '#';
  if (alter >= 2) return '##';
  return '';
}

/** A coarse inverse of `kindOf` for third-party harmonies that carry no display text. */
const KIND_SUFFIX: Record<string, string> = {
  major: '',
  minor: 'm',
  augmented: 'aug',
  diminished: 'dim',
  dominant: '7',
  'major-seventh': 'maj7',
  'minor-seventh': 'm7',
  'diminished-seventh': 'dim7',
  'augmented-seventh': 'aug7',
  'half-diminished': 'm7b5',
  'major-minor': 'mMaj7',
  'major-sixth': '6',
  'minor-sixth': 'm6',
  'dominant-ninth': '9',
  'major-ninth': 'maj9',
  'minor-ninth': 'm9',
  'dominant-11th': '11',
  'dominant-13th': '13',
  'suspended-second': 'sus2',
  'suspended-fourth': 'sus4',
  power: '5',
};

/**
 * Fifths + mode → a key signature (V8b). The inverse of `keyFifths` (`@sibei/model`), picking the
 * conventional key name for each position on the circle. Verified against `keyFifths` in a test.
 */
export function keyFromFifths(fifths: number, mode: Mode): KeySignature {
  const table = mode === 'minor' ? MINOR_KEYS : MAJOR_KEYS;
  const found = table[fifths];
  if (found === undefined) return { tonic: mode === 'minor' ? 'A' : 'C', alter: 0, mode };
  return { tonic: found.tonic, alter: found.alter, mode };
}

const MAJOR_KEYS: Record<number, { tonic: Step; alter: Alter }> = {
  [-7]: { tonic: 'C', alter: -1 },
  [-6]: { tonic: 'G', alter: -1 },
  [-5]: { tonic: 'D', alter: -1 },
  [-4]: { tonic: 'A', alter: -1 },
  [-3]: { tonic: 'E', alter: -1 },
  [-2]: { tonic: 'B', alter: -1 },
  [-1]: { tonic: 'F', alter: 0 },
  [0]: { tonic: 'C', alter: 0 },
  [1]: { tonic: 'G', alter: 0 },
  [2]: { tonic: 'D', alter: 0 },
  [3]: { tonic: 'A', alter: 0 },
  [4]: { tonic: 'E', alter: 0 },
  [5]: { tonic: 'B', alter: 0 },
  [6]: { tonic: 'F', alter: 1 },
  [7]: { tonic: 'C', alter: 1 },
};

const MINOR_KEYS: Record<number, { tonic: Step; alter: Alter }> = {
  [-7]: { tonic: 'A', alter: -1 },
  [-6]: { tonic: 'E', alter: -1 },
  [-5]: { tonic: 'B', alter: -1 },
  [-4]: { tonic: 'F', alter: 0 },
  [-3]: { tonic: 'C', alter: 0 },
  [-2]: { tonic: 'G', alter: 0 },
  [-1]: { tonic: 'D', alter: 0 },
  [0]: { tonic: 'A', alter: 0 },
  [1]: { tonic: 'E', alter: 0 },
  [2]: { tonic: 'B', alter: 0 },
  [3]: { tonic: 'F', alter: 1 },
  [4]: { tonic: 'C', alter: 1 },
  [5]: { tonic: 'G', alter: 1 },
  [6]: { tonic: 'D', alter: 1 },
  [7]: { tonic: 'A', alter: 1 },
};
