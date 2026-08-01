import { durationTicks } from './duration.js';
import { parsePitch } from './pitch.js';
import type {
  Annotation,
  Bar,
  BarItem,
  Chord,
  Dots,
  Duration,
  EndBarline,
  Ending,
  Id,
  KeySignature,
  Note,
  NoteValue,
  Review,
  Score,
  ScoreMeta,
  Section,
  StartBarline,
  Rest,
  TimeSignature,
  Tuplet,
} from './score.js';
import { SCHEMA_VERSION } from './score.js';

/**
 * Plain constructors with the defaults every object needs. Nothing here writes to a
 * store — the op applier is the only writer (ADR-0003). These exist so the op
 * applier, the codecs and the fixtures all build the same shapes.
 */

export function noReview(): Review {
  return { flagged: false, reasons: [] };
}

export function dur(value: NoteValue, dots: Dots = 0): Duration {
  return { value, dots };
}

export interface NoteInit {
  id: Id;
  onset: number;
  duration: Duration;
  /** A compact pitch spec, `Eb5`, or a Pitch. */
  pitch: string | Note['pitch'];
  accidental?: Note['accidental'];
  tie?: Note['tie'];
  spellingPinned?: boolean;
  confidence?: Note['confidence'];
  review?: Review;
}

export function makeNote(init: NoteInit): Note {
  return {
    kind: 'note',
    id: init.id,
    onset: init.onset,
    duration: init.duration,
    pitch: typeof init.pitch === 'string' ? parsePitch(init.pitch) : init.pitch,
    accidental: init.accidental ?? 'auto',
    tie: init.tie ?? 'none',
    spellingPinned: init.spellingPinned ?? false,
    confidence: init.confidence ?? null,
    review: init.review ?? noReview(),
  };
}

export interface RestInit {
  id: Id;
  onset: number;
  duration: Duration;
  confidence?: Rest['confidence'];
  review?: Review;
}

export function makeRest(init: RestInit): Rest {
  return {
    kind: 'rest',
    id: init.id,
    onset: init.onset,
    duration: init.duration,
    confidence: init.confidence ?? null,
    review: init.review ?? noReview(),
  };
}

export interface ChordInit {
  id: Id;
  onset: number;
  text: string;
  confidence?: Chord['confidence'];
  review?: Review;
}

export function makeChord(init: ChordInit): Chord {
  return {
    id: init.id,
    onset: init.onset,
    text: init.text,
    confidence: init.confidence ?? null,
    review: init.review ?? noReview(),
  };
}

export function makeAnnotation(init: ChordInit): Annotation {
  return makeChord(init);
}

export interface BarInit {
  id: Id;
  number: number;
  items?: BarItem[];
  tuplets?: Tuplet[];
  chords?: Chord[];
  annotations?: Annotation[];
  startBarline?: StartBarline;
  endBarline?: EndBarline;
  ending?: Ending | null;
  review?: Review;
}

export function makeBar(init: BarInit): Bar {
  return {
    id: init.id,
    number: init.number,
    items: init.items ?? [],
    tuplets: init.tuplets ?? [],
    chords: init.chords ?? [],
    annotations: init.annotations ?? [],
    startBarline: init.startBarline ?? 'none',
    endBarline: init.endBarline ?? 'single',
    ending: init.ending ?? null,
    review: init.review ?? noReview(),
  };
}

export interface SectionInit {
  id: Id;
  startBar: number;
  letter?: string | null;
  name?: string | null;
}

export function makeSection(init: SectionInit): Section {
  return {
    id: init.id,
    startBar: init.startBar,
    letter: init.letter ?? null,
    name: init.name ?? null,
  };
}

export const DEFAULT_KEY: KeySignature = { tonic: 'C', alter: 0, mode: 'major' };

export const DEFAULT_TIME: TimeSignature = { beats: 4, beatValue: 4 };

export interface ScoreInit {
  id: Id;
  title?: string;
  composer?: string;
  style?: string | null;
  key?: KeySignature;
  time?: TimeSignature;
  bars?: Bar[];
  sections?: Section[];
}

export function makeScore(init: ScoreInit): Score {
  const meta: ScoreMeta = {
    // A missing title is the empty string, not the word 'Untitled' (KAN-594). Defaulting to a
    // literal name destroyed the one fact only creation knows: the document is the truth
    // (ADR-0028), so storing 'Untitled' leaves nothing able to tell a chart somebody *named*
    // "Untitled" from a chart nobody has named. Both surfaces already depend on that distinction
    // existing — the library draws an unnamed chart in italics with its id beside it, and page 1's
    // title band collapses rather than reserving room for a row it never draws (KAN-525).
    //
    // It is defaulted here rather than in each client on purpose: a default every caller has to
    // remember to send is a default the surfaces agree on only until one of them forgets (Q79).
    // `composer` and `style` below already worked this way; `title` was the odd one out.
    title: init.title ?? '',
    composer: init.composer ?? '',
    style: init.style ?? null,
    key: init.key ?? DEFAULT_KEY,
    time: init.time ?? DEFAULT_TIME,
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    id: init.id,
    meta,
    bars: init.bars ?? [],
    sections: init.sections ?? [],
  };
}

/**
 * Onsets implied by laying items out end to end from the start of the bar. Used when
 * building a bar from a sequence; it does not consult tuplets, so a caller with
 * tuplets must supply onsets itself or scale afterwards.
 */
export function sequentialOnsets(durations: readonly Duration[]): number[] {
  const onsets: number[] = [];
  let cursor = 0;
  for (const duration of durations) {
    onsets.push(cursor);
    cursor += durationTicks(duration);
  }
  return onsets;
}
