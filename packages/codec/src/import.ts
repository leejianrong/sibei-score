/**
 * MusicXML → Score (V8b, ADR-0004).
 *
 * The reverse of `export.ts`. It reads `score-partwise`: the first part's measures become the bar grid, and every
 * part, staff and voice (ADR-0041 slice 5a) becomes a real part, staff and voice of the draft; `<note>`s become
 * notes and rests with their ties and tuplets;
 * `<harmony>` becomes chord symbols; `<barline>`, `<ending>` and `<rehearsal>` become the structure
 * V7 added. What MusicXML never carried is minted fresh or defaulted — new ids, `accidental: 'auto'`,
 * `spellingPinned: false`, no confidence or review, no style line — which is the round-trip's lossy
 * half, named case by case in `tests`.
 *
 * **Read leniently** (the codec's half of ADR-0012's rule): a fifth voice, an unsupported note
 * type, or a key change mid-piece is dropped with a warning rather than refused, because an imported
 * document is not the place to be strict — the model stores and flags, it does not reject. The size of what is
 * read is bounded (parts, staves, voices) because the file is untrusted (SIB2-152).
 */

import {
  ARTICULATIONS,
  MAX_TEMPO,
  MAX_VOICES,
  MIN_TEMPO,
  NAV_KINDS,
  DYNAMICS,
  MAX_LYRIC_LENGTH,
  MAX_VERSES,
  NAV_SIGNS,
  NAV_TEXT,
  barCapacity,
  durationTicks,
  restPieces,
  drumById,
  drumForGm,
  isNoteheadKind,
  parseDrum,
  makeAnnotation,
  makeBar,
  makeChord,
  makeNote,
  makeRest,
  MAX_CHORD_TONES,
  chordTones,
  toneWithPitch,
  makeScore,
  makeSection,
  transposePitch,
  transposeSpelling,
} from '@sibei/model';
import type {
  Alter,
  BarItem,
  Clef,
  DrumId,
  Ending,
  Interval,
  NoteheadKind,
  Part,
  Staff,
  StaffBar,
  Voice,
  GraceNote,
  Dynamic,
  Lyric,
  HairpinShape,
  EndingRole,
  KeySignature,
  Mode,
  NavKind,
  NoteValue,
  Score,
  Articulation,
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
import { exportedPartName } from './export.js';
import { fromTransposeElement, inverse } from './transposition.js';

const TICKS_PER_QUARTER = 480;

/**
 * The size of what a file may add (SIB2-152, ADR-0041 slice 5a). A file is untrusted: each is far above anything a
 * real score has, and a file past one is read up to it with a warning, never refused.
 */
export const MAX_PARTS = 32;
export const MAX_STAVES_PER_PART = 8;
export const MAX_TOTAL_STAVES = 32;
/** Distinct voice numbers read on one staff before they are mapped onto our four. */
const MAX_VOICE_LABELS = 16;
/** A `<forward>`, `<backup>` or note longer than this many ticks (a hundred bars of 4/4) is read as zero. */
const MAX_TICKS = TICKS_PER_QUARTER * 400;

export interface ImportResult {
  score: Score;
  /** MusicXML this codec met but could not keep — a second voice, a mid-piece key change, and such. */
  warnings: string[];
}

/** A document this codec cannot read at all (not well-formed, or not a single-voice lead sheet). */
export class ImportError extends Error {
  /** `unsupported` is a well-formed document in a shape this codec does not read (score-timewise). */
  constructor(
    message: string,
    readonly kind: 'malformed' | 'unsupported' = 'malformed',
  ) {
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
    throw new ImportError('score-timewise is not supported; convert to score-partwise first', 'unsupported');
  }
  if (root.name !== 'score-partwise') {
    throw new ImportError(`expected a <score-partwise> document, found <${root.name}>`);
  }

  const warnings: string[] = [];
  const title = childText(firstChild(root, 'work') ?? root, 'work-title') ?? '';
  const composer = composerOf(root);

  const partElements = childElements(root, 'part');
  if (partElements.length === 0) throw new ImportError('the document has no <part>');
  if (childElements(partElements[0] as XmlElement, 'measure').length === 0) throw new ImportError('the part has no <measure>');

  const counter = { n: 0 };
  const read: ReadPart[] = [];
  let staves = 0;
  for (const [index, element] of partElements.entries()) {
    const measures = childElements(element, 'measure');
    warnLossyContent(measures, warnings);
    const reader = new PartReader(warnings, counter, index === 0, drumInstruments(root, attr(element, 'id') ?? ''));
    const result = reader.read(measures);
    if (index > 0 && (index >= MAX_PARTS || staves + result.content.staffCount > MAX_TOTAL_STAVES)) {
      const dropped = partElements.length - index;
      warnings.push(
        `${dropped} further part${dropped === 1 ? '' : 's'} dropped: a score reads at most ${MAX_PARTS} parts and ${MAX_TOTAL_STAVES} staves`,
      );
      break;
    }
    staves += result.content.staffCount;
    read.push({ element, measures, result });
  }

  const primary = (read[0] as ReadPart).result;
  // The first part's measures are the bar grid; a later part with more measures is cut to it, one with fewer leaves
  // the rest of its staves empty.
  for (const [index, part] of read.entries()) {
    if (index > 0 && part.measures.length > primary.bars.length) {
      warnings.push(`measures after bar ${primary.bars.length} of a later part were dropped: the first part sets the length`);
      break;
    }
  }

  // A transposing first part is written in its own key: the score's key is the concert one.
  let key = primary.key;
  const primaryShift = primary.content.transpose;
  if (primaryShift !== null) {
    const concert = transposeSpelling({ step: key.tonic, alter: key.alter }, inverse(primaryShift.written), key, true);
    key = { tonic: concert.step, alter: concert.alter, mode: key.mode };
  }

  const { bars, sections, spanners, time, tempo } = primary;
  const score = makeScore({
    id: options.id ?? 'imported',
    title,
    composer,
    key,
    time,
    bars,
    sections,
  });
  const names = partNames(root);
  let staffNumber = 0;
  score.parts = read.map((part, index) => {
    const built = buildPart(
      part.result.content,
      index,
      staffNumber,
      score,
      names.get(attr(part.element, 'id') ?? '') ?? null,
      warnings,
    );
    staffNumber += built.staves.length;
    return built;
  });
  // A draft of several staves is set the way a score is, by width; a single staff keeps the four-bar grid (ADR-0041 section 5).
  if (staffNumber > 1) score.meta.layout = 'score';
  // `<rights>` is the one MusicXML home for the footer text; the pages it prints on are ours, so it comes
  // back on every page.
  if (spanners.length > 0) score.spanners = spanners;
  const rights = rightsOf(root);
  if (rights !== '') score.meta.footer = { text: rights, pages: 'all' };
  if (tempo !== undefined) score.meta.tempo = tempo;
  const subtitle = (childText(root, 'movement-title') ?? '').trim();
  if (subtitle !== '') score.meta.subtitle = subtitle;
  const arranger = creditsOf(root, 'arranger').join(' / ');
  if (arranger !== '') score.meta.arranger = arranger;
  return { score, warnings };
}

interface ReadPart {
  element: XmlElement;
  measures: XmlElement[];
  result: ReadResult;
}

/**
 * The drum each `<score-instrument>` of a part stands for (slice 6): by its `<midi-unpitched>` (1-based General MIDI
 * key) when the drum map knows it, else by its name. An instrument neither says anything about stays unmapped, and its
 * notes are plain percussion hits at their display pitch.
 */
function drumInstruments(root: XmlElement, partId: string): Map<string, DrumId> {
  const out = new Map<string, DrumId>();
  const list = firstChild(root, 'part-list');
  if (list === null) return out;
  const scorePart = childElements(list, 'score-part').find((candidate) => attr(candidate, 'id') === partId);
  if (scorePart === undefined) return out;
  const midiKeys = new Map<string, number>();
  for (const midi of childElements(scorePart, 'midi-instrument')) {
    const id = attr(midi, 'id');
    const key = Number(childText(midi, 'midi-unpitched'));
    if (id !== null && Number.isInteger(key)) midiKeys.set(id, key - 1);
  }
  for (const instrument of childElements(scorePart, 'score-instrument')) {
    const id = attr(instrument, 'id');
    if (id === null) continue;
    const key = midiKeys.get(id);
    const drum = (key === undefined ? null : drumForGm(key)) ?? parseDrum(childText(instrument, 'instrument-name') ?? '');
    if (drum !== null) out.set(id, drum);
  }
  return out;
}

/** A `<score-part>`'s name and General MIDI program (1-based in MusicXML, 0-based here), by its id. */
function partNames(root: XmlElement): Map<string, { name: string; shortName: string; program: number | null }> {
  const out = new Map<string, { name: string; shortName: string; program: number | null }>();
  const list = firstChild(root, 'part-list');
  if (list === null) return out;
  for (const scorePart of childElements(list, 'score-part')) {
    const id = attr(scorePart, 'id');
    if (id === null) continue;
    const midi = firstChild(scorePart, 'midi-instrument');
    const program = midi === null ? NaN : Number(childText(midi, 'midi-program'));
    out.set(id, {
      name: (childText(scorePart, 'part-name') ?? '').trim(),
      shortName: (childText(scorePart, 'part-abbreviation') ?? '').trim(),
      program: Number.isInteger(program) && program >= 1 && program <= 128 ? program - 1 : null,
    });
  }
  return out;
}

/**
 * What the model still has no home for, named once each so the import is never silently thinner than the file
 * (SIB2-152). (Dynamics and hairpins are read since SIB2-274 and lyrics since SIB2-273, so nothing is named here now
 * but the lyric cases `readLyrics` meets.) (Slurs, unsupported clefs and the rest are named by the part reader
 * as it meets them. Extra parts, staves and voices are no longer lost: ADR-0041 slice 5a.)
 */
function warnLossyContent(measures: XmlElement[], warnings: string[]): void {
  const found = new Set<string>();
  for (const measure of measures) {
    for (const child of childElements(measure)) {
      if (child.name === 'note' && firstChild(child, 'lyric') !== null && firstChild(child, 'rest') !== null) {
        found.add('lyrics on a rest were dropped: a syllable belongs to a note');
      }
    }
  }
  for (const w of found) if (!warnings.includes(w)) warnings.push(w);
}

function rightsOf(root: XmlElement): string {
  const identification = firstChild(root, 'identification');
  return identification === null ? '' : (childText(identification, 'rights') ?? '').trim();
}

/** Every composer creator, one per line (SIB2-180: a second composer is a second line). */
function composerOf(root: XmlElement): string {
  return creditsOf(root, 'composer').join('\n');
}

function creditsOf(root: XmlElement, type: string): string[] {
  const identification = firstChild(root, 'identification');
  if (identification === null) return [];
  return childElements(identification, 'creator')
    .filter((creator) => attr(creator, 'type') === type)
    .map((creator) => textContent(creator).trim())
    .filter((line) => line !== '');
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
  content: PartContent;
}

/** One voice's notes in one measure while it is being read, keyed by staff and MusicXML voice label. */
interface VoiceAcc {
  items: BarItem[];
  tuplets: Tuplet[];
  open: OpenTuplet | null;
  /** Where the last item ends, so a note that starts before it is known to overlap. */
  end: number;
}

interface MeasureContent {
  /** Key `${staff}|${label}`. */
  voices: Map<string, VoiceAcc>;
  /** The clef each staff is given in this measure's attributes. */
  clefs: Map<number, Clef>;
}

/** What a part holds beyond the grid the first part sets: staves, voices, clefs and its transposition. */
interface PartContent {
  measures: MeasureContent[];
  staffCount: number;
  percussionStaves: Set<number>;
  /** The voice labels met on each staff, in the order first met. */
  labels: Map<number, string[]>;
  /** `<transpose>`: the semitones from sounding to written and the interval that written pitch is above concert. */
  transpose: { semitones: number; written: Interval } | null;
}

/** A tuplet being accumulated across consecutive time-modified notes. */
interface OpenTuplet {
  actual: number;
  normal: number;
  memberIds: string[];
}

class PartReader {
  private percussionStaves = new Set<number>();
  /** Where the last note of the measure began, for a `<chord/>` note that shares it. */
  private lastOnset: number | null = null;
  private labels = new Map<number, string[]>();
  private staffCount = 1;
  private transpose: PartContent['transpose'] = null;
  private contents: MeasureContent[] = [];
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
  /** A dynamic and a wedge begun by directions, waiting for the next note or rest (SIB2-274). */
  private pendingDynamic: Dynamic | null = null;
  private pendingWedge: { number: number; shape: HairpinShape } | null = null;
  private openWedges = new Map<number, { startId: string; shape: HairpinShape }>();
  /** Grace notes read and waiting for the note that follows them (SIB2-185). */
  private pendingGraces: GraceNote[] = [];
  /** Dashed lines begun and not yet stopped, by MusicXML `number` (SIB2-170): the annotation each continues. */
  private openDashes = new Map<number, string>();
  private dashEnds: { annotationId: string; endNumber: number }[] = [];
  /** An ending open on an earlier bar, so a bar between its start and stop reads as `continue`. */
  private openEnding: number[] | null = null;

  /**
   * `primary` is the first part, which sets everything that belongs to the whole score: the key, meter, tempo,
   * chords, text, rehearsal letters, barlines and line breaks. A later part contributes only its notes, clefs and
   * transposition (the chord lane is above the top staff, ADR-0041 section 3). `counter` is shared so every id in the
   * draft is unique.
   */
  constructor(
    private readonly warnings: string[],
    private readonly counter: { n: number },
    private readonly primary: boolean,
    /** The drums this part's `<score-instrument>`s stand for, by instrument id (slice 6). */
    private readonly drums: ReadonlyMap<string, DrumId> = new Map(),
  ) {}

  private id(prefix: string): string {
    this.counter.n += 1;
    return `${prefix}-${this.counter.n}`;
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
      if (this.primary && index > 0 && previous !== undefined && this.startsNewSystem(measure)) {
        bars[index - 1] = { ...previous, lineBreak: 'after' };
      }
    });

    if (this.pendingGraces.length > 0) this.note('grace notes with no note after them were dropped');
    if (this.openSlurs.size > 0) this.note('a slur that never stopped was dropped');
    if (this.openOttavas.size > 0) this.note('an ottava that never stopped was dropped');
    if (this.openWedges.size > 0 || this.pendingWedge !== null) this.note('a hairpin that never stopped was dropped');
    for (const end of this.dashEnds) {
      const target = bars.find((bar) => bar.number === end.endNumber);
      if (target === undefined) continue;
      for (const [index, bar] of bars.entries()) {
        if (!bar.annotations.some((a) => a.id === end.annotationId) || bar.number > target.number) continue;
        bars[index] = {
          ...bar,
          annotations: bar.annotations.map((a) => (a.id === end.annotationId ? { ...a, lineEndBarId: target.id } : a)),
        };
      }
    }
    return {
      bars,
      sections,
      spanners: this.spanners,
      key: this.key,
      time: this.time,
      tempo: this.tempo,
      content: {
        measures: this.contents,
        staffCount: this.staffCount,
        percussionStaves: this.percussionStaves,
        labels: this.labels,
        transpose: this.transpose,
      },
    };
  }

  private readMeasure(measure: XmlElement, index: number, sections: Section[]): ReturnType<typeof makeBar> {
    const number = this.barNumber(measure, index);
    const content: MeasureContent = { voices: new Map(), clefs: new Map() };
    this.contents.push(content);
    const chords: { id: string; onset: number; text: string }[] = [];
    const annotations: { id: string; onset: number; text: string }[] = [];

    let cursor = 0;
    const navs: NavKind[] = [];
    let startBarline: 'none' | 'repeat-start' = 'none';
    let endBarline: 'single' | 'double' | 'final' | 'repeat-end' = 'single';
    let hasStart = false;
    let hasStop = false;
    let endingNumbers: number[] | null = null;
    let noteSeen = false;

    for (const child of childElements(measure)) {
      switch (child.name) {
        case 'attributes':
          this.readAttributes(child, content, noteSeen);
          break;

        case 'note': {
          const staff = this.staffOf(child);
          const label = (childText(child, 'voice') ?? '1').trim() || '1';
          let acc = staff === null ? null : this.voiceAcc(content, staff, label);
          // Two notes over the same stretch of one voice (a file that rewinds with a backup but never numbers its
          // voices) are two voices, so each goes to the first voice of the staff that is free there.
          if (acc !== null && cursor < acc.end && firstChild(child, 'grace') === null && firstChild(child, 'chord') === null) {
            this.note('overlapping notes with one voice number were read as separate voices');
            for (let n = 1; acc !== null && cursor < acc.end; n += 1) {
              acc = this.voiceAcc(content, staff as number, `${label}+${n}`);
            }
          }
          if (acc === null) {
            // A staff or voice past the bounds: the note still takes its time, so the rest of the measure stays in step.
            this.pendingGraces = [];
            if (firstChild(child, 'grace') === null && firstChild(child, 'chord') === null) cursor += this.ticksOf(child);
            break;
          }
          noteSeen = true;
          if (firstChild(child, 'grace') !== null) {
            // Held until the note it precedes is read; it takes no time (SIB2-185).
            const grace = this.readGrace(child);
            if (grace !== null) this.pendingGraces.push(grace);
            break;
          }
          if (firstChild(child, 'chord') !== null && firstChild(child, 'unpitched') !== null && this.lastOnset !== null) {
            // Drums struck together are written as a chord in one voice (hi-hat and snare); a voice here holds one item
            // per onset, so each further drum goes to a voice of its own beside it (slice 6).
            const at = this.lastOnset;
            let target: VoiceAcc | null = null;
            for (let n = 1; n <= MAX_VOICES && target === null; n += 1) {
              const candidate = this.voiceAcc(content, staff as number, `${label}+c${n}`);
              if (candidate === null) break;
              if (!candidate.items.some((item) => item.onset === at)) target = candidate;
            }
            if (target === null) {
              this.note('a chord note (a second simultaneous pitch) was dropped: one pitch per voice');
              break;
            }
            const parsed = this.readNote(child, at);
            this.percussionStaves.add(staff as number);
            target.items.push(parsed.item);
            target.end = Math.max(target.end, at + parsed.ticks);
            this.note('drums struck together were read as separate voices');
            break;
          }
          if (firstChild(child, 'chord') !== null) {
            // A `<chord/>` note joins the note it follows as another pitch of one stacked chord (SIB2-243); that was
            // "a chord note was dropped" before. Anything that cannot join is still named, never silently lost.
            const host = acc.items[acc.items.length - 1];
            if (host === undefined || host.kind !== 'note' || host.drum !== undefined || this.lastOnset !== host.onset) {
              this.note('a chord note with no note to join was dropped');
              break;
            }
            const joined = this.readNote(child, host.onset);
            if (joined.item.kind !== 'note' || joined.unpitched) {
              this.note('a chord note that is a rest or unpitched was dropped');
              break;
            }
            const pitch = joined.item.pitch;
            if (toneWithPitch(host, pitch) !== undefined) {
              this.note('a chord note repeating a pitch of its chord was dropped');
              break;
            }
            if (chordTones(host).length >= MAX_CHORD_TONES) {
              this.note(`a chord of more than ${MAX_CHORD_TONES} pitches was cut to ${MAX_CHORD_TONES}`);
              break;
            }
            host.stack = [
              ...(host.stack ?? []),
              { id: joined.item.id, pitch, accidental: joined.item.accidental, tie: joined.item.tie, spellingPinned: false },
            ];
            break;
          }
          const parsed = this.readNote(child, cursor);
          this.lastOnset = cursor;
          if (parsed.unpitched) this.percussionStaves.add(staff as number);
          const notations = firstChild(child, 'notations');
          if (notations !== null && firstChild(notations, 'fermata') !== null) parsed.item.fermata = true;
          if (parsed.item.kind === 'note') {
            const lyrics = this.readLyrics(child);
            if (lyrics.length > 0) parsed.item.lyrics = lyrics;
          }
          if (this.pendingDynamic !== null) {
            parsed.item.dynamic = this.pendingDynamic;
            this.pendingDynamic = null;
          }
          if (notations !== null && parsed.item.kind === 'note') {
            const marks = this.readArticulations(notations);
            if (marks.length > 0) parsed.item.articulations = marks;
          }
          if (this.pendingGraces.length > 0) {
            if (parsed.item.kind === 'note') parsed.item.graces = this.pendingGraces;
            else this.note('grace notes before a rest were dropped: a grace note belongs to a note');
            this.pendingGraces = [];
          }
          acc.items.push(parsed.item);
          this.readSlurs(child, parsed.item);
          if (parsed.item.kind === 'note') {
            this.lastNoteId = parsed.item.id;
            if (this.pendingOttava !== null) {
              this.openOttavas.set(this.pendingOttava.number, { startId: parsed.item.id, shift: this.pendingOttava.shift });
              this.pendingOttava = null;
            }
            if (this.pendingWedge !== null) {
              this.openWedges.set(this.pendingWedge.number, { startId: parsed.item.id, shape: this.pendingWedge.shape });
              this.pendingWedge = null;
            }
          }
          acc.open = this.trackTuplet(acc.open, acc.tuplets, parsed);
          cursor += parsed.ticks;
          acc.end = cursor;
          break;
        }

        case 'forward':
          cursor += this.ticksOf(child);
          break;

        case 'backup':
          // A rewind: the next notes start another voice (or staff) over the same stretch of the measure.
          cursor = Math.max(0, cursor - this.ticksOf(child));
          break;

        case 'harmony': {
          if (!this.primary) break;
          const chord = this.readHarmony(child, cursor);
          if (chord !== null) chords.push(chord);
          break;
        }

        case 'direction': {
          // Only an octave shift is a note's, so a later part reads it; the rest belongs to the whole score.
          if (!this.primary) {
            this.readOctaveShift(child);
            this.readDynamicMarks(child);
            break;
          }
          // A navigation mark (SIB2-175) is the bar's, and its words ("D.S. al Coda") are not a text direction.
          const nav = this.navOf(child);
          if (nav !== null) {
            const jump = !NAV_SIGNS.includes(nav);
            if (navs.includes(nav)) break;
            if (jump && navs.some((k) => !NAV_SIGNS.includes(k))) this.note(`a second jump mark (${NAV_TEXT[nav]}) on bar ${number} was dropped: one per bar`);
            else navs.push(nav);
            break;
          }
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
          this.readDynamicMarks(child);
          this.readDashes(child, annotations[annotations.length - 1]?.id ?? null, number);
          const letter = this.rehearsalOf(child);
          if (letter !== null && !sections.some((s) => s.startBar === number)) {
            sections.push(makeSection({ id: this.id('section'), startBar: number, letter }));
          }
          break;
        }

        case 'barline': {
          if (!this.primary) break;
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
    for (const acc of content.voices.values()) {
      if (acc.open !== null) acc.tuplets.push({ id: this.id('tuplet'), ...acc.open });
      acc.open = null;
    }

    const ending = this.resolveEnding(hasStart, hasStop, endingNumbers);

    const bar = makeBar({
      id: this.id('bar'),
      number,
      chords: chords.map((c) => makeChord(c)),
      annotations: annotations.map((a) => makeAnnotation(a)),
      startBarline,
      endBarline,
      ending,
    });
    return navs.length === 0 ? bar : { ...bar, nav: NAV_KINDS.filter((k) => navs.includes(k)) };
  }

  /**
   * A `<grace>` note: its pitch, a value from `<type>` (eighth by default, a longer type is read as an eighth), and
   * `slash="yes"` for an acciaccatura. A grace with no pitch (unpitched) is dropped with a note.
   */
  private readGrace(el: XmlElement): GraceNote | null {
    const unpitched = firstChild(el, 'unpitched');
    const pitch = firstChild(el, 'pitch') ?? unpitched;
    if (pitch === null) {
      this.note('a grace note with no pitch was dropped');
      return null;
    }
    const display = pitch === unpitched;
    const type = childText(el, 'type');
    const value = type === '16th' ? 16 : type === '32nd' ? 32 : 8;
    const written = firstChild(el, 'accidental');
    const grace = firstChild(el, 'grace');
    return {
      id: this.id('grace'),
      pitch: {
        step: stepOf(childText(pitch, display ? 'display-step' : 'step')),
        alter: display ? 0 : clampAlter(Number(childText(pitch, 'alter') ?? 0)),
        octave: octaveOf(childText(pitch, display ? 'display-octave' : 'octave')),
      },
      value,
      slashed: grace !== null && attr(grace, 'slash') === 'yes',
      accidental: written !== null && attr(written, 'parentheses') === 'yes' ? 'parens' : 'auto',
    };
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

  /**
   * `<lyric number syllabic text extend>` on a note (SIB2-273): one syllable per verse. The verse is the `number`
   * attribute when it is 1 to 4 (else the lyric's place among the note's), and one outside that, a second syllable
   * for a verse, or one with no text (`<humming/>`) is named and dropped.
   */
  private readLyrics(note: XmlElement): Lyric[] {
    const found: Lyric[] = [];
    for (const [index, el] of childElements(note, 'lyric').entries()) {
      const given = attr(el, 'number');
      const verse = given === null || !/^\d+$/.test(given) ? index + 1 : Number(given);
      const text = childText(el, 'text');
      if (text === null || text.trim() === '') {
        this.note('a lyric with no text (humming, laughing) was dropped');
        continue;
      }
      if (verse < 1 || verse > MAX_VERSES) {
        this.note(`a lyric in verse ${verse} was dropped: a note carries verses 1 to ${MAX_VERSES}`);
        continue;
      }
      if (found.some((lyric) => lyric.verse === verse)) {
        this.note(`a second lyric for verse ${verse} on one note was dropped`);
        continue;
      }
      const syllabic = childText(el, 'syllabic');
      const clean = text.trim().slice(0, MAX_LYRIC_LENGTH);
      found.push({
        verse,
        text: clean,
        syllabic: syllabic === 'begin' || syllabic === 'middle' || syllabic === 'end' ? syllabic : 'single',
        ...(firstChild(el, 'extend') !== null ? { extend: true as const } : {}),
      });
    }
    return found.sort((a, b) => a.verse - b.verse);
  }

  /**
   * `<dynamics>` and `<wedge>` in a direction (SIB2-274). A dynamic marks the next note or rest; the closed set is read
   * and any other (`fz`, `pppp`, `other-dynamics`) is named and dropped. A wedge start waits for the next note, and a
   * stop closes on the note just read, as an octave shift does.
   */
  private readDynamicMarks(direction: XmlElement): void {
    for (const type of childElements(direction, 'direction-type')) {
      for (const group of childElements(type, 'dynamics')) {
        const mark = childElements(group)[0];
        if (mark === undefined) continue;
        if ((DYNAMICS as readonly string[]).includes(mark.name)) this.pendingDynamic = mark.name as Dynamic;
        else this.note(`the dynamic <${mark.name}> was dropped: only ${DYNAMICS.join(', ')} are kept`);
      }
      for (const wedge of childElements(type, 'wedge')) {
        const kind = attr(wedge, 'type');
        const number = Number(attr(wedge, 'number') ?? 1);
        if (kind === 'stop') {
          const open = this.openWedges.get(number);
          this.openWedges.delete(number);
          if (open === undefined || this.lastNoteId === null || open.startId === this.lastNoteId) {
            this.note('a hairpin stop with no start was dropped');
            continue;
          }
          this.spanners.push({ id: this.id('hairpin'), kind: 'hairpin', startId: open.startId, endId: this.lastNoteId, hairpin: open.shape });
        } else if (kind === 'crescendo' || kind === 'diminuendo') {
          this.pendingWedge = { number, shape: kind };
        }
      }
    }
  }

  /** `<articulations>` in `<notations>`: staccato, accent and the strong accent (our marcato); others are noted and dropped. */
  private readArticulations(notations: XmlElement): Articulation[] {
    const found = new Set<Articulation>();
    for (const group of childElements(notations, 'articulations')) {
      for (const mark of childElements(group)) {
        if (mark.name === 'staccato') found.add('staccato');
        else if (mark.name === 'accent') found.add('accent');
        else if (mark.name === 'strong-accent') found.add('marcato');
        else this.note(`the articulation <${mark.name}> was dropped: only staccato, accent and marcato are kept`);
      }
    }
    return ARTICULATIONS.filter((mark) => found.has(mark));
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

  private readAttributes(el: XmlElement, content: MeasureContent, noteSeen: boolean): void {
    const divisions = Number(childText(el, 'divisions'));
    if (Number.isFinite(divisions) && divisions > 0 && divisions <= 1_000_000) this.divisions = divisions;

    const staves = Number(childText(el, 'staves'));
    if (Number.isInteger(staves) && staves > 1) this.growStaves(staves);

    for (const clef of childElements(el, 'clef')) {
      const number = Number(attr(clef, 'number') ?? 1);
      if (!Number.isInteger(number) || number < 1 || !this.growStaves(number)) continue;
      const read = this.clefOf(clef);
      if (read === null) continue;
      if (noteSeen) this.note('a clef change inside a bar was moved to the start of the bar');
      content.clefs.set(number, read);
    }

    const transpose = firstChild(el, 'transpose');
    if (transpose !== null && this.transpose === null) this.readTranspose(transpose);

    if (!this.primary) return;
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

  /** Make room for staff `count`; false (and a warning) past the per-part bound. */
  private growStaves(count: number): boolean {
    if (count > MAX_STAVES_PER_PART) {
      this.note(`staves past the ${MAX_STAVES_PER_PART}th of a part were dropped`);
      return false;
    }
    this.staffCount = Math.max(this.staffCount, count);
    return true;
  }

  /** The staff a note is on: its `<staff>` (default 1), or null past the bound. */
  private staffOf(note: XmlElement): number | null {
    const raw = childText(note, 'staff');
    const number = raw === null ? 1 : Number(raw);
    if (!Number.isInteger(number) || number < 1) return 1;
    return this.growStaves(number) ? number : null;
  }

  /** The accumulator for a staff's voice, or null when the staff already has all the voice numbers it may. */
  private voiceAcc(content: MeasureContent, staff: number, label: string): VoiceAcc | null {
    const known = this.labels.get(staff) ?? [];
    if (!known.includes(label)) {
      if (known.length >= MAX_VOICE_LABELS) {
        this.note(`voices past the ${MAX_VOICE_LABELS}th number met on one staff were dropped`);
        return null;
      }
      known.push(label);
      this.labels.set(staff, known);
    }
    const key = `${staff}|${label}`;
    let acc = content.voices.get(key);
    if (acc === undefined) {
      acc = { items: [], tuplets: [], open: null, end: 0 };
      content.voices.set(key, acc);
    }
    return acc;
  }

  /** `<clef>`: the sign and line mapped onto the five clefs the model has; others are read as the nearest, with a note. */
  private clefOf(clef: XmlElement): Clef | null {
    const sign = childText(clef, 'sign');
    const line = Number(childText(clef, 'line') ?? NaN);
    const octave = Number(childText(clef, 'clef-octave-change') ?? 0);
    if (octave !== 0 && Number.isFinite(octave)) this.note('an octave mark on a clef was dropped');
    switch (sign) {
      case 'G':
        if (line !== 2 && Number.isFinite(line)) this.note('a clef on a line other than the usual one was read as the standard clef');
        return 'treble';
      case 'F':
        if (line !== 4 && Number.isFinite(line)) this.note('a clef on a line other than the usual one was read as the standard clef');
        return 'bass';
      case 'C':
        if (line === 4) return 'tenor';
        if (line !== 3 && Number.isFinite(line)) this.note('a clef on a line other than the usual one was read as the standard clef');
        return 'alto';
      case 'percussion':
        return 'percussion';
      case 'TAB':
        this.note('a tablature staff was read as a standard staff');
        return 'treble';
      default:
        return null;
    }
  }

  /** `<transpose>` (written to sounding) as the part's semitones from sounding to written, and its spelled interval. */
  private readTranspose(el: XmlElement): void {
    const chromatic = Number(childText(el, 'chromatic') ?? 0);
    const octaveChange = Number(childText(el, 'octave-change') ?? 0);
    const diatonicText = childText(el, 'diatonic');
    const diatonic = diatonicText === null ? null : Number(diatonicText);
    if (![chromatic, octaveChange].every(Number.isInteger) || (diatonic !== null && !Number.isInteger(diatonic))) return;
    if (Math.abs(chromatic) > 36 || Math.abs(octaveChange) > 3 || (diatonic !== null && Math.abs(diatonic) > 21)) {
      this.note('a transposition of more than three octaves was dropped');
      return;
    }
    const values = fromTransposeElement({ diatonic, chromatic, octaveChange });
    if (values.semitones === 0) return;
    this.transpose = values;
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
    /** A percussion note (`<unpitched>`): its pitch is only where it sits on the staff. */
    unpitched: boolean;
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
      return { item: makeRest({ id: this.id('rest'), onset, duration: { value, dots } }), ticks, tuplet, unpitched: false };
    }

    const unpitched = firstChild(el, 'unpitched');
    const pitch = firstChild(el, 'pitch') ?? unpitched;
    if (pitch === null) {
      // Neither a rest nor a pitch: treat as a rest so the bar's timing survives.
      this.note('a note with no pitch was read as a rest');
      return { item: makeRest({ id: this.id('rest'), onset, duration: { value, dots } }), ticks, tuplet, unpitched: false };
    }

    const display = unpitched !== null && pitch === unpitched;
    const step = stepOf(childText(pitch, display ? 'display-step' : 'step'));
    const alter = display ? 0 : clampAlter(Number(childText(pitch, 'alter') ?? 0));
    const octave = octaveOf(childText(pitch, display ? 'display-octave' : 'octave'));
    // `<accidental parentheses="yes">` is a cautionary accidental (SIB2-182).
    const written = firstChild(el, 'accidental');
    const cautionary = written !== null && attr(written, 'parentheses') === 'yes';

    const drum = display ? this.drumOf(el) : null;
    const head = display ? this.headOf(el, drum) : null;
    return {
      item: makeNote({
        id: this.id('note'),
        onset,
        duration: { value, dots },
        pitch: { step, alter, octave },
        tie: tieOf(el),
        ...(cautionary ? { accidental: 'parens' as const } : {}),
        ...(drum === null ? {} : { drum, accidental: 'hide' as const }),
        ...(head === null ? {} : { head }),
      }),
      ticks,
      tuplet,
      unpitched: display,
    };
  }

  /** The drum a percussion note names through `<instrument id>`, if the part's instruments say. */
  private drumOf(el: XmlElement): DrumId | null {
    const instrument = firstChild(el, 'instrument');
    const id = instrument === null ? null : attr(instrument, 'id');
    return id === null ? null : (this.drums.get(id) ?? null);
  }

  /**
   * A percussion note's `<notehead>`, kept only when it is not what its drum is drawn with anyway (the model derives the
   * drum's own head). A kind the model has no head for is read as an x, with a note.
   */
  private headOf(el: XmlElement, drum: DrumId | null): NoteheadKind | null {
    const text = childText(el, 'notehead')?.trim();
    if (text === undefined || text === '') return null;
    let kind: NoteheadKind;
    if (isNoteheadKind(text)) kind = text;
    else {
      this.note(`a notehead of kind "${text}" was read as an x`);
      kind = 'x';
    }
    return drum !== null && drumById(drum).head === kind ? null : kind;
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

  /**
   * A navigation mark (SIB2-175): `<segno/>` or `<coda/>`, or a `<sound>` that jumps (`dacapo`, `dalsegno`, `tocoda`,
   * `fine`), the printed words saying which "al" it is. Words that are exactly a mark's text with no `<sound>` are
   * read as the mark too, for files that print "D.S. al Coda" and encode nothing.
   */
  private navOf(direction: XmlElement): NavKind | null {
    const types = childElements(direction, 'direction-type');
    if (types.some((type) => firstChild(type, 'segno') !== null)) return 'segno';
    if (types.some((type) => firstChild(type, 'coda') !== null)) return 'coda';
    const sound = firstChild(direction, 'sound');
    const words = (this.wordsOf(direction) ?? '').toLowerCase();
    const al = (base: 'dc' | 'ds'): NavKind => (words.includes('fine') ? `${base}-al-fine` : words.includes('coda') ? `${base}-al-coda` : base) as NavKind;
    if (sound !== null) {
      if (attr(sound, 'dacapo') === 'yes') return al('dc');
      if (attr(sound, 'dalsegno') !== null) return al('ds');
      if (attr(sound, 'tocoda') !== null) return 'to-coda';
      if (attr(sound, 'fine') !== null) return 'fine';
      return null;
    }
    return NAV_KINDS.find((kind) => NAV_TEXT[kind]?.toLowerCase() === words) ?? null;
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

  /**
   * `<dashes type="start|stop" number>` (SIB2-170): a start follows the words direction it continues; a stop
   * names the bar the line closes on. Paired after every measure is read, by number.
   */
  private readDashes(direction: XmlElement, lastAnnotationId: string | null, barNumber: number): void {
    for (const type of childElements(direction, 'direction-type')) {
      for (const dashes of childElements(type, 'dashes')) {
        const key = Number(attr(dashes, 'number') ?? 1);
        if (attr(dashes, 'type') === 'start') {
          if (lastAnnotationId === null) this.note('a dashed line with no text direction before it was dropped');
          else this.openDashes.set(key, lastAnnotationId);
        } else if (attr(dashes, 'type') === 'stop') {
          const annotationId = this.openDashes.get(key);
          if (annotationId !== undefined) {
            this.dashEnds.push({ annotationId, endNumber: barNumber });
            this.openDashes.delete(key);
          }
        }
      }
    }
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
    const duration = Number(childText(el, 'duration'));
    if (!Number.isFinite(duration) || duration < 0) return 0;
    const ticks = this.scale(duration);
    // Past a hundred bars is a hostile or corrupt number, not music.
    return ticks > MAX_TICKS ? 0 : ticks;
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
// Parts, staves and voices
// ---------------------------------------------------------------------------

/**
 * One part of the draft from what its reader gathered (ADR-0041 slice 5a). Staves and parts are numbered across
 * the score in order (`staff-1`...), a staff's voices are renumbered onto 1 to 4, a clef change becomes a
 * `StaffBar.clef`, and a transposing part's pitches (written in the file) are brought back to concert.
 */
function buildPart(
  content: PartContent,
  partIndex: number,
  staffOffset: number,
  score: Score,
  info: { name: string; shortName: string; program: number | null } | null,
  warnings: string[],
): Part {
  const shift = content.transpose;
  const staves: Staff[] = [];
  for (let number = 1; number <= content.staffCount; number += 1) {
    const labelMap = voiceIndexMap(content.labels.get(number) ?? [], number - 1, warnings);
    const percussionNotes = content.percussionStaves.has(number);
    const fallback: Clef = percussionNotes ? 'percussion' : 'treble';

    let opening: Clef | null = null;
    let current: Clef = fallback;
    const changes = new Map<number, Clef>();
    content.measures.forEach((measure, index) => {
      const clef = measure.clefs.get(number);
      if (clef === undefined) return;
      if (opening === null) {
        opening = index === 0 ? clef : fallback;
        current = opening;
      }
      if (clef !== current) {
        changes.set(index, clef);
        current = clef;
      }
    });
    const clef: Clef = opening ?? fallback;
    const percussion = percussionNotes || clef === 'percussion';

    const indexes = [...new Set([1, ...labelMap.values()])].sort((a, b) => a - b);
    // A percussion note's pitch is a place on the staff, so it never moves.
    const toConcert = shift === null || percussion ? null : inverse(shift.written);
    const bars = score.bars.map((bar, barIndex): StaffBar => {
      const measure = content.measures[barIndex];
      const voices = indexes.map((index): Voice => {
        const label = [...labelMap].find(([, mapped]) => mapped === index)?.[0];
        const acc = label === undefined ? undefined : measure?.voices.get(`${number}|${label}`);
        const items = label !== undefined && label.includes('+c') ? withRestsBetween(acc?.items ?? [], score, barIndex, `${staffOffset + number}-${index}`) : (acc?.items ?? []);
        return {
          index,
          items: toConcert === null ? items : items.map((item) => concertItem(item, toConcert, score.meta.key)),
          tuplets: acc?.tuplets ?? [],
        };
      });
      const change = changes.get(barIndex);
      return change === undefined ? { barId: bar.id, voices } : { barId: bar.id, voices, clef: change };
    });
    staves.push({ id: `staff-${staffOffset + number}`, type: percussion ? 'percussion' : 'standard', clef, bars });
  }

  // The names this codec itself writes for an unnamed part are not names.
  const written = info?.name ?? '';
  const name = written === exportedPartName(score, { name: '' }, partIndex) ? '' : written;
  return {
    id: `part-${partIndex + 1}`,
    name,
    ...(info === null || info.shortName === '' ? {} : { shortName: info.shortName }),
    instrument: info?.program ?? null,
    transposition: shift?.semitones ?? 0,
    staves,
  };
}

/** A note brought from written to concert pitch by the part's interval (graces too); a rest is as it was. */
function concertItem(item: BarItem, interval: Interval, key: KeySignature): BarItem {
  if (item.kind !== 'note') return item;
  const move = (pitch: typeof item.pitch): typeof item.pitch => transposePitch(pitch, interval, key, true);
  return {
    ...item,
    pitch: clampPitch(move(item.pitch)),
    ...(item.graces === undefined ? {} : { graces: item.graces.map((grace) => ({ ...grace, pitch: clampPitch(move(grace.pitch)) })) }),
  };
}

function clampPitch(pitch: { step: Step; alter: Alter; octave: number }): { step: Step; alter: Alter; octave: number } {
  return { ...pitch, alter: clampAlter(pitch.alter) };
}

/**
 * A voice made from a drum chord (slice 6) holds only the hits that were struck with another, so its gaps are filled
 * with rests the way every other voice's are (the file's rests belong to the voice the chord began in). They are not
 * drawn on a drum kit (voices 3 and 4), but they make the voice fill its bar.
 */
function withRestsBetween(items: BarItem[], score: Score, barIndex: number, key: string): BarItem[] {
  const bar = score.bars[barIndex];
  const capacity = bar === undefined || bar.number === 0 ? 0 : barCapacity(score.meta.time);
  const out: BarItem[] = [];
  let cursor = 0;
  let serial = 0;
  const fill = (to: number): void => {
    for (const duration of restPieces(cursor, to - cursor)) {
      serial += 1;
      out.push(makeRest({ id: `rest-c${key}-${barIndex}-${serial}`, onset: cursor, duration }));
      cursor += durationTicks(duration);
    }
  };
  for (const item of items) {
    if (item.onset > cursor) fill(item.onset);
    out.push(item);
    cursor = Math.max(cursor, item.onset + durationTicks(item.duration));
  }
  if (items.length > 0 && cursor < capacity) fill(capacity);
  return out;
}

/**
 * MusicXML numbers voices per part, our model per staff from 1 to 4. A file that numbers the way this codec does
 * (`4 * staffIndex + voice`, which is how MuseScore numbers them too) keeps its numbers; otherwise a staff's voices
 * are ranked in numeric order. A fifth voice on a staff is dropped, named in a warning.
 */
function voiceIndexMap(labels: readonly string[], staffIndex: number, warnings: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const numeric = (label: string): number => (/^\d{1,6}$/.test(label) ? Number(label) : Number.NaN);
  const own = labels.every((label) => {
    const index = numeric(label) - 4 * staffIndex;
    return index >= 1 && index <= MAX_VOICES;
  });
  if (own) {
    for (const label of labels) out.set(label, numeric(label) - 4 * staffIndex);
    return out;
  }
  const ranked = [...labels].sort((a, b) => {
    const [x, y] = [numeric(a), numeric(b)];
    if (Number.isNaN(x) && Number.isNaN(y)) return a < b ? -1 : a > b ? 1 : 0;
    if (Number.isNaN(x)) return 1;
    if (Number.isNaN(y)) return -1;
    return x - y;
  });
  ranked.forEach((label, rank) => {
    if (rank < MAX_VOICES) out.set(label, rank + 1);
    else {
      const warning = `voices past the ${MAX_VOICES}th on a staff were dropped`;
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  });
  return out;
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

const STEPS: readonly Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

function stepOf(text: string | null): Step {
  const step = (text ?? '').trim() as Step;
  return STEPS.includes(step) ? step : 'C';
}

function octaveOf(text: string | null): number {
  const octave = Math.round(Number(text ?? 4));
  return Number.isFinite(octave) ? Math.min(10, Math.max(-1, octave)) : 4;
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
