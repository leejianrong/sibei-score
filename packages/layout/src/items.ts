import type {
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
  text: string;
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
}

export interface RestItem {
  kind: 'rest';
  restId: Id;
  onset: number;
  beat: number;
  duration: Duration;
  tupletId: Id | null;
  flagged: boolean;
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
  | NoteItem
  | RestItem
  | ChordSymbolItem
  | AnnotationItem
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
  'note',
  'rest',
  'chordSymbol',
  'annotation',
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
