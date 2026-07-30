/**
 * The score model. The runtime truth (ADR-0004) — MusicXML is a codec at the edges
 * and never appears here.
 *
 * Framework-free, Node-free plain TypeScript, because this file runs in the browser
 * and on the server (ADR-0005, ADR-0022).
 */

/** Bumped by any change to the document shape, with a forward-only migration (ADR-0028). */
export const SCHEMA_VERSION = 1;

/**
 * An app-owned stable identifier, e.g. `note-17` (ADR-0007). Internal: it does not
 * survive MusicXML export.
 */
export type Id = string;

// ---------------------------------------------------------------------------
// Pitch
// ---------------------------------------------------------------------------

export type Step = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';

/** Semitone displacement of a step: -2 double flat through +2 double sharp. */
export type Alter = -2 | -1 | 0 | 1 | 2;

/**
 * A pitch with its spelling made explicit. A score always stores concert pitch
 * (ADR-0016); written pitch exists only at export time.
 */
export interface Pitch {
  step: Step;
  alter: Alter;
  /** Scientific pitch notation: middle C is octave 4. */
  octave: number;
}

export type Mode = 'major' | 'minor';

export interface KeySignature {
  tonic: Step;
  alter: Alter;
  mode: Mode;
}

// ---------------------------------------------------------------------------
// Rhythm
// ---------------------------------------------------------------------------

/** The denominator of a note value: 1 is a whole note, 32 a thirty-second. */
export type NoteValue = 1 | 2 | 4 | 8 | 16 | 32;

export type Dots = 0 | 1 | 2;

export interface Duration {
  value: NoteValue;
  dots: Dots;
}

/** One time signature per chart in both milestones (ADR-0021). */
export interface TimeSignature {
  beats: number;
  beatValue: NoteValue;
}

// ---------------------------------------------------------------------------
// Flags carried by every object
// ---------------------------------------------------------------------------

export type ReviewReason =
  | 'low-confidence'
  | 'unparsed-chord'
  | 'metrically-invalid'
  | 'unrecognised-text';

/**
 * Rendered as highlighting on screen and `!` in the text projection (ADR-0009,
 * ADR-0019). Nothing in v0.1 sets it; the field exists from the first commit so
 * v0.2 needs no migration (ADR-0026).
 */
export interface Review {
  flagged: boolean;
  reasons: ReviewReason[];
}

/** Recognition confidence in [0, 1], or null when nothing measured it. */
export type Confidence = number | null;

// ---------------------------------------------------------------------------
// Bar contents
// ---------------------------------------------------------------------------

/** Whether an accidental is drawn. `auto` derives it from the key signature. */
export type AccidentalDisplay = 'auto' | 'show' | 'hide';

/** A tie may start on a note, end on it, or both when it is mid-chain. */
export type TieRole = 'none' | 'start' | 'stop' | 'both';

export interface Note {
  kind: 'note';
  id: Id;
  /** Ticks from the start of the bar. See TICKS_PER_QUARTER. */
  onset: number;
  duration: Duration;
  pitch: Pitch;
  accidental: AccidentalDisplay;
  tie: TieRole;
  /** An explicit spelling that survives transposition (ADR-0017). */
  spellingPinned: boolean;
  confidence: Confidence;
  review: Review;
}

/** A first-class object, not an implied gap — metric validity depends on it (ADR-0013). */
export interface Rest {
  kind: 'rest';
  id: Id;
  onset: number;
  duration: Duration;
  confidence: Confidence;
  review: Review;
}

export type BarItem = Note | Rest;

/** Triplet brackets are the supported case (ADR-0021); the ratio is general. */
export interface Tuplet {
  id: Id;
  /** Notes written, e.g. 3 for a triplet. */
  actual: number;
  /** Notes' worth of time occupied, e.g. 2 for a triplet. */
  normal: number;
  memberIds: Id[];
}

/**
 * A chord symbol anchored to a position in the bar. `text` is always the verbatim
 * input: unparseable text is kept and flagged, never rejected (ADR-0012). Parsing to
 * structure arrives with the `music` package in V5.
 */
export interface Chord {
  id: Id;
  onset: number;
  text: string;
  confidence: Confidence;
  review: Review;
}

/** Non-chord text found in the chord band, kept rather than discarded (Q56). */
export interface Annotation {
  id: Id;
  onset: number;
  text: string;
  confidence: Confidence;
  review: Review;
}

export type StartBarline = 'none' | 'repeat-start';

export type EndBarline = 'single' | 'double' | 'final' | 'repeat-end';

export type EndingRole = 'start' | 'continue' | 'stop' | 'start-stop';

/** 1st/2nd endings over a repeated section. Supported, not detected (ADR-0021). */
export interface Ending {
  numbers: number[];
  role: EndingRole;
}

export interface Bar {
  id: Id;
  /** 0 is the pickup bar; bar 1 is the first full bar (ADR-0007). */
  number: number;
  /** In onset order. Ordinal addressing breaks ties by insertion order (ADR-0007). */
  items: BarItem[];
  tuplets: Tuplet[];
  chords: Chord[];
  annotations: Annotation[];
  startBarline: StartBarline;
  endBarline: EndBarline;
  ending: Ending | null;
  review: Review;
}

// ---------------------------------------------------------------------------
// Structure and the score itself
// ---------------------------------------------------------------------------

/**
 * A named division of the form. Load-bearing for layout, not only notation: a
 * section boundary forces a line break (ADR-0015).
 */
export interface Section {
  id: Id;
  /** The bar number the section begins on. */
  startBar: number;
  /** The rehearsal letter, when the section carries one. */
  letter: string | null;
  name: string | null;
}

export interface ScoreMeta {
  title: string;
  composer: string;
  /** The optional style or tempo line. */
  style: string | null;
  key: KeySignature;
  time: TimeSignature;
}

export interface Score {
  schemaVersion: number;
  id: Id;
  meta: ScoreMeta;
  /** In bar-number order. A pickup, when present, is `bars[0]` with number 0. */
  bars: Bar[];
  sections: Section[];
}
