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

import { MAX_TEMPO, MIN_TEMPO, makeAnnotation, makeBar, makeChord, makeNote, makeRest, makeScore, makeSection } from '@sibei/model';
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
  Spanner,
  Step,
  Tempo,
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
  const { bars, sections, spanners, key, time, tempo } = reader.read(measures);

  const score = makeScore({
    id: options.id ?? 'imported',
    title,
    composer,
    key,
    time,
    bars,
    sections,
  });
  // `<rights>` is the one MusicXML home for the footer text; the pages it prints on are ours, so it comes
  // back on every page.
  if (spanners.length > 0) score.spanners = spanners;
  const rights = rightsOf(root);
  if (rights !== '') score.meta.footer = { text: rights, pages: 'all' };
  if (tempo !== undefined) score.meta.tempo = tempo;
  return { score, warnings };
}

function rightsOf(root: XmlElement): string {
  const identification = firstChild(root, 'identification');
  return identification === null ? '' : (childText(identification, 'rights') ?? '').trim();
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
  spanners: Spanner[];
  key: KeySignature;
  time: { beats: number; beatValue: NoteValue };
  tempo: Tempo | undefined;
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
  /** The first metronome mark (SIB2-177); later ones in the piece are dropped, one tempo per score. */
  private tempo: Tempo | undefined;
  /** Slurs begun and not yet stopped, by MusicXML `number` (SIB2-167). */
  private openSlurs = new Map<number, { startId: string; placement?: 'above' | 'below' }>();
  private spanners: Spanner[] = [];
  /** Ottava lines (SIB2-184): one begun by a `<octave-shift>` and waiting for its first note, or open, by number. */
  private pendingOttava: { number: number; shift: 'up' | 'down' } | null = null;
  private openOttavas = new Map<number, { startId: string; shift: 'up' | 'down' }>();
  private lastNoteId: string | null = null;
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

    // `<print new-system="yes"/>` on a measure ends the line before it, which is our `lineBreak: 'after'`
    // on the bar just above (SIB2-174). A file that breaks every line therefore keeps its own breaks.
    measures.forEach((measure, index) => {
      const previous = bars[index - 1];
      if (index > 0 && previous !== undefined && this.startsNewSystem(measure)) {
        bars[index - 1] = { ...previous, lineBreak: 'after' };
      }
    });

    if (this.openSlurs.size > 0) this.note('a slur that never stopped was dropped');
    if (this.openOttavas.size > 0) this.note('an ottava that never stopped was dropped');
    return { bars, sections, spanners: this.spanners, key: this.key, time: this.time, tempo: this.tempo };
  }

  private readMeasure(measure: XmlElement, index: number, sections: Section[]): ReturnType<typeof makeBar> {
    const number = this.barNumber(measure, index);
    const items: BarItem[] = [];
    const tuplets: Tuplet[] = [];
    const chords: { id: string; onset: number; text: string }[] = [];
    const annotations: { id: string; onset: number; text: string }[] = [];

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
          this.readSlurs(child, parsed.item);
          if (parsed.item.kind === 'note') {
            this.lastNoteId = parsed.item.id;
            if (this.pendingOttava !== null) {
              this.openOttavas.set(this.pendingOttava.number, { startId: parsed.item.id, shift: this.pendingOttava.shift });
              this.pendingOttava = null;
            }
          }
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
          const words = this.wordsOf(child);
          if (words !== null) {
            const offset = childText(child, 'offset');
            annotations.push({
              id: this.id('annotation'),
              onset: cursor + (offset === null ? 0 : this.scale(Number(offset))),
              text: words,
            });
          }
          if (this.tempo === undefined) this.tempo = this.metronomeOf(child);
          this.readOctaveShift(child);
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
      annotations: annotations.map((a) => makeAnnotation(a)),
      startBarline,
      endBarline,
      ending,
    });
  }

  /**
   * `<octave-shift type size number>` (SIB2-184). MusicXML's `down` means the notes are *printed* an octave lower,
   * which is our 8va (`up`); `up` is our 8vb. Only an octave (size 8) is read. A start waits for the next note; a
   * stop closes on the note just read.
   */
  private readOctaveShift(direction: XmlElement): void {
    for (const type of childElements(direction, 'direction-type')) {
      for (const shift of childElements(type, 'octave-shift')) {
        const kind = attr(shift, 'type');
        const number = Number(attr(shift, 'number') ?? 1);
        if (kind === 'stop') {
          const open = this.openOttavas.get(number);
          this.openOttavas.delete(number);
          if (open === undefined || this.lastNoteId === null || open.startId === this.lastNoteId) {
            this.note('an ottava stop with no start was dropped');
            continue;
          }
          this.spanners.push({ id: this.id('ottava'), kind: 'ottava', startId: open.startId, endId: this.lastNoteId, octaveShift: open.shift });
        } else if (kind === 'up' || kind === 'down') {
          if (attr(shift, 'size') !== null && attr(shift, 'size') !== '8') {
            this.note('a two-octave shift was dropped: only 8va and 8vb are read');
            continue;
          }
          this.pendingOttava = { number, shift: kind === 'down' ? 'up' : 'down' };
        }
      }
    }
  }

  /** `<notations><slur type number placement/>` on a note: open it, or close it into a spanner. */
  private readSlurs(el: XmlElement, item: BarItem): void {
    const notations = firstChild(el, 'notations');
    if (notations === null) return;
    for (const slur of childElements(notations, 'slur')) {
      const type = attr(slur, 'type');
      const number = Number(attr(slur, 'number') ?? 1);
      if (item.kind !== 'note') {
        this.note('a slur on a rest was dropped');
        continue;
      }
      if (type === 'start') {
        const placement = attr(slur, 'placement');
        this.openSlurs.set(number, {
          startId: item.id,
          ...(placement === 'above' || placement === 'below' ? { placement } : {}),
        });
      } else if (type === 'stop') {
        const open = this.openSlurs.get(number);
        this.openSlurs.delete(number);
        if (open === undefined || open.startId === item.id) {
          this.note('a slur stop with no start was dropped');
          continue;
        }
        this.spanners.push({ id: this.id('slur'), kind: 'slur', startId: open.startId, endId: item.id, ...(open.placement === undefined ? {} : { placement: open.placement }) });
      }
    }
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
    // `<accidental parentheses="yes">` is a cautionary accidental (SIB2-182).
    const written = firstChild(el, 'accidental');
    const cautionary = written !== null && attr(written, 'parentheses') === 'yes';

    return {
      item: makeNote({
        id: this.id('note'),
        onset,
        duration: { value, dots },
        pitch: { step, alter, octave },
        tie: tieOf(el),
        ...(cautionary ? { accidental: 'parens' as const } : {}),
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

  /** The text of a `<words>` direction (a cue, a tempo, "unis."), or null when it is some other kind. */
  private wordsOf(direction: XmlElement): string | null {
    for (const type of childElements(direction, 'direction-type')) {
      const words = firstChild(type, 'words');
      if (words !== null) {
        const text = textContent(words).trim();
        if (text !== '') return text;
      }
    }
    return null;
  }

  /** A `<metronome>` with a beat unit and a per-minute number, or undefined (a range or a tied pair is skipped). */
  private metronomeOf(direction: XmlElement): Tempo | undefined {
    for (const type of childElements(direction, 'direction-type')) {
      const metronome = firstChild(type, 'metronome');
      if (metronome === null) continue;
      const unit = childText(metronome, 'beat-unit');
      const value = unit === null ? undefined : ({ whole: 1, half: 2, quarter: 4, eighth: 8 } as const)[unit as 'whole'];
      const bpm = Number(childText(metronome, 'per-minute'));
      if (value === undefined || !Number.isInteger(bpm) || bpm < MIN_TEMPO || bpm > MAX_TEMPO) continue;
      const dots = firstChild(metronome, 'beat-unit-dot') === null ? 0 : 1;
      return { unit: { value, dots }, bpm };
    }
    return undefined;
  }

  private startsNewSystem(measure: XmlElement): boolean {
    return childElements(measure, 'print').some((print) => attr(print, 'new-system') === 'yes');
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
