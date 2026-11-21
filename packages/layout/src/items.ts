import type {
  Articulation,
  AccidentalDisplay,
  Alter,
  Duration,
  EndBarline,
  EndingRole,
  Id,
  KeySignature,
  Pitch,
  StartBarline,
  TieRole,
  TimeSignature,
} from '@sibei/model';

/**
 * The layout contract (`PLAN.md`, ADR-0014). Everything below is engine-independent:
 * nothing here may mention VexFlow, and the draw adapter consumes only this.
 *
 * The division of labour: layout owns everything above the bar — which bars go on
 * which line, where each bar box sits and how wide it is, page breaks, the header.
 * The draw adapter owns engraving inside a bar box: stem direction, beam grouping,
 * accidental stacking, note spacing within the box. That is the split ADR-0014
 * assumes when it lists what VexFlow supplies and what stays ours.
 */

export type Clef = 'treble';

export interface ClefItem {
  kind: 'clef';
  clef: Clef;
}

export interface KeySignatureItem {
  kind: 'keySignature';
  key: KeySignature;
  /** Position on the circle of fifths: positive sharps, negative flats. */
  fifths: number;
}

export interface TimeSignatureItem {
  kind: 'timeSignature';
  time: TimeSignature;
}

export interface BarNumberItem {
  kind: 'barNumber';
  text: string;
}

export interface RehearsalMarkItem {
  kind: 'rehearsalMark';
  sectionId: Id;
  /** The letter, or '' for a section that has only a name. */
  text: string;
  /** The section's name (SIB2-176), boxed beside the letter; absent when the section has none. */
  name?: string;
}

/** The tempo mark (SIB2-177): on the score's first bar only, above the staff, after any rehearsal box. */
export interface TempoItem {
  kind: 'tempo';
  unit: { value: number; dots: number };
  bpm: number;
}

export interface NoteItem {
  kind: 'note';
  noteId: Id;
  /** Ticks from the start of the bar. */
  onset: number;
  /** The 1-based beat the onset falls on, as the CLI addresses it. */
  beat: number;
  duration: Duration;
  pitch: Pitch;
  /** The model's request. `auto` has already been resolved into `accidentalGlyph`. */
  accidental: AccidentalDisplay;
  /**
   * The accidental to draw, or null for none. Which accidental appears is a notation
   * decision — it depends on the key signature and on what the bar has already
   * altered — so it is resolved here, engine-independently. Stacking and collision
   * avoidance remain the draw adapter's job (ADR-0014).
   */
  accidentalGlyph: Alter | null;
  tie: TieRole;
  tupletId: Id | null;
  flagged: boolean;
  /** A fermata above this note (SIB2-183). */
  fermata?: boolean;
  /** Staccato, accent and marcato marks, in stacking order (SIB2-179). */
  articulations?: Articulation[];
}

export interface RestItem {
  kind: 'rest';
  restId: Id;
  onset: number;
  beat: number;
  duration: Duration;
  tupletId: Id | null;
  flagged: boolean;
  /** A fermata above this rest (SIB2-183). */
  fermata?: boolean;
}

export interface ChordSymbolItem {
  kind: 'chordSymbol';
  chordId: Id;
  onset: number;
  beat: number;
  /** Verbatim chord text; the draw adapter typesets it, it does not validate it. */
  text: string;
  /**
   * The note or rest the symbol sits above — the onset at or before the chord's own.
   * Null when the bar has nothing to anchor to.
   */
  anchorItemId: Id | null;
  flagged: boolean;
}

export interface AnnotationItem {
  kind: 'annotation';
  annotationId: Id;
  onset: number;
  beat: number;
  text: string;
  anchorItemId: Id | null;
  flagged: boolean;
  /** A dashed line begins after this text (SIB2-170); `endsHere` when it closes in this same bar. */
  line?: { endsHere: boolean };
}

/**
 * The middle or end of a text direction's dashed line (SIB2-170), on each later bar it covers. Segments abut across
 * barlines and across a system break, so a line that wraps simply continues on the next system's first bar.
 */
export interface DirectionLineItem {
  kind: 'directionLine';
  annotationId: Id;
  /** The bar the line closes on: it ends with a hook rather than running on to the barline. */
  endsHere: boolean;
}

export interface TupletBracketItem {
  kind: 'tupletBracket';
  tupletId: Id;
  actual: number;
  normal: number;
  memberIds: Id[];
}

export interface BarlineItem {
  kind: 'barline';
  position: 'start';
  barline: StartBarline;
}

export interface EndBarlineItem {
  kind: 'endBarline';
  position: 'end';
  barline: EndBarline;
}

export interface EndingItem {
  kind: 'ending';
  numbers: number[];
  role: EndingRole;
}

export type LayoutBarItem =
  | ClefItem
  | KeySignatureItem
  | TimeSignatureItem
  | BarNumberItem
  | RehearsalMarkItem
  | TempoItem
  | NoteItem
  | RestItem
  | ChordSymbolItem
  | AnnotationItem
  | DirectionLineItem
  | TupletBracketItem
  | BarlineItem
  | EndBarlineItem
  | EndingItem;

export type LayoutBarItemKind = LayoutBarItem['kind'];

/**
 * Every kind the contract can emit. The draw adapter must handle all of them, which
 * is asserted rather than trusted.
 */
export const LAYOUT_BAR_ITEM_KINDS: readonly LayoutBarItemKind[] = [
  'clef',
  'keySignature',
  'timeSignature',
  'barNumber',
  'rehearsalMark',
  'tempo',
  'note',
  'rest',
  'chordSymbol',
  'annotation',
  'directionLine',
  'tupletBracket',
  'barline',
  'endBarline',
  'ending',
];

export type LayoutTextRole = 'title' | 'composer' | 'style';

export const LAYOUT_TEXT_ROLES: readonly LayoutTextRole[] = ['title', 'composer', 'style'];

export interface LayoutText {
  role: LayoutTextRole;
  text: string;
  x: number;
  /** Baseline. */
  y: number;
  size: number;
  align: 'left' | 'center' | 'right';
}

/**
 * A tie between two note onsets. A null endpoint means the tie continues past this
 * system's edge, so the adapter draws a partial curve.
 */
export interface LayoutTie {
  fromNoteId: Id | null;
  toNoteId: Id | null;
}

/**
 * A slur between two notes (SIB2-167/168). Like a tie, a null endpoint means it continues past this
 * system's edge, so a slur that crosses a system break is two of these, one on each side. `placement`
 * is the score's choice; absent, the engraver decides from the stems under the curve.
 */
export interface LayoutSlur {
  id: Id;
  fromNoteId: Id | null;
  toNoteId: Id | null;
  placement?: 'above' | 'below';
}
