/**
 * Page geometry for the layout engine.
 *
 * Layout works in **units**, where one staff space is 10 units. That is VexFlow's
 * natural coordinate space, so the draw adapter never rescales anything, and a single
 * `pointsPerUnit` maps the page to paper. A4 and Letter, A4 default (Q38).
 */

export type Paper = 'a4' | 'letter';

export interface PaperSize {
  widthPt: number;
  heightPt: number;
}

export const PAPER_SIZES: Record<Paper, PaperSize> = {
  a4: { widthPt: 595.28, heightPt: 841.89 },
  letter: { widthPt: 612, heightPt: 792 },
};

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PageSpecInput {
  paper?: Paper;
  /** Points per layout unit. Smaller means a smaller staff and more systems per page. */
  pointsPerUnit?: number;
  margin?: Partial<Margins>;
  /** Minimum room above the staff. A system with high notes or chords takes more. */
  aboveStaff?: number;
  /** Minimum room below the staff. A system with low notes takes more. */
  belowStaff?: number;
  /** Gap between the tallest ink in a system and the chord symbol baseline. */
  chordClearance?: number;
  /** Room a line of chord symbols occupies above its baseline. */
  chordAscent?: number;
  /** Room a rehearsal letter occupies above the chord band. */
  rehearsalBand?: number;
  systemGap?: number;
  /** Room reserved on page 1 for the title block. */
  headerHeight?: number;
  /**
   * Justification policy: how much of a system's width is shared equally between its
   * bars rather than in proportion to their contents. 1 is a rigid grid, 0 is fully
   * content-proportional. Jazz charts read as a grid, so this leans high.
   */
  equalWeight?: number;
  minBarWidth?: number;
}

export interface PageSpec {
  paper: Paper;
  pointsPerUnit: number;
  /** Paper size in points, as the PDF page will be. */
  widthPt: number;
  heightPt: number;
  /** Paper size in layout units. */
  width: number;
  height: number;
  margin: Margins;
  staffSpace: number;
  staffHeight: number;
  aboveStaff: number;
  belowStaff: number;
  chordClearance: number;
  chordAscent: number;
  rehearsalBand: number;
  /** The height of a system with nothing unusual in it. Systems may be taller. */
  systemHeight: number;
  systemGap: number;
  headerHeight: number;
  titleSize: number;
  composerSize: number;
  styleSize: number;
  equalWeight: number;
  minBarWidth: number;
}

/** One staff space. Five lines, four spaces, so a staff is 40 units tall. */
export const STAFF_SPACE = 10;

export const DEFAULT_POINTS_PER_UNIT = 0.6;

const DEFAULT_MARGIN: Margins = { top: 56, right: 64, bottom: 56, left: 64 };

export function resolvePageSpec(input: PageSpecInput = {}): PageSpec {
  const paper = input.paper ?? 'a4';
  const pointsPerUnit = input.pointsPerUnit ?? DEFAULT_POINTS_PER_UNIT;
  const size = PAPER_SIZES[paper];
  const staffSpace = STAFF_SPACE;
  const staffHeight = staffSpace * 4;
  const aboveStaff = input.aboveStaff ?? 46;
  const belowStaff = input.belowStaff ?? 26;
  return {
    paper,
    pointsPerUnit,
    widthPt: size.widthPt,
    heightPt: size.heightPt,
    width: size.widthPt / pointsPerUnit,
    height: size.heightPt / pointsPerUnit,
    margin: { ...DEFAULT_MARGIN, ...input.margin },
    staffSpace,
    staffHeight,
    aboveStaff,
    belowStaff,
    chordClearance: input.chordClearance ?? 12,
    chordAscent: input.chordAscent ?? 16,
    rehearsalBand: input.rehearsalBand ?? 30,
    systemHeight: aboveStaff + staffHeight + belowStaff,
    systemGap: input.systemGap ?? 20,
    headerHeight: input.headerHeight ?? 104,
    titleSize: 30,
    composerSize: 16,
    styleSize: 15,
    equalWeight: input.equalWeight ?? 0.64,
    minBarWidth: input.minBarWidth ?? 90,
  };
}

export function unitsToPoints(units: number, spec: PageSpec): number {
  return units * spec.pointsPerUnit;
}
