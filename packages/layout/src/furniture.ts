import type { Score } from '@sibei/model';
import type { PageSpec } from './page.js';

/**
 * Page furniture: text that belongs to the page rather than to the score's music — page numbers
 * (SIB2-171) and, later, the footer (SIB2-172). It is a **render-time choice** like the paper, not
 * a field of the score, so it rides in on the `PageSpecInput` and changes nothing about where the
 * systems go: furniture sits in the margin bands, outside the area `paginate` fills.
 */

export type PageNumberPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export const PAGE_NUMBER_POSITIONS: readonly PageNumberPosition[] = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

/** `n` is "2", `page` is "Page 2", `of` is "Page 2 of 3". */
export type PageNumberFormat = 'n' | 'page' | 'of';

export const PAGE_NUMBER_FORMATS: readonly PageNumberFormat[] = ['n', 'page', 'of'];

export interface PageNumberSettings {
  position: PageNumberPosition;
  format: PageNumberFormat;
  /** Whether page 1 carries a number. Many printed charts leave the first page bare. */
  first: boolean;
}

export const DEFAULT_PAGE_NUMBERS: PageNumberSettings = {
  position: 'top-right',
  format: 'n',
  first: true,
};

export type LayoutFurnitureRole = 'pageNumber' | 'footer';

export interface LayoutFurniture {
  role: LayoutFurnitureRole;
  text: string;
  x: number;
  /** Baseline. */
  y: number;
  size: number;
  align: 'left' | 'center' | 'right';
}

const FURNITURE_SIZE = 14;
/** Baselines sit inside the margin bands, so furniture never competes with a system for room. */
const TOP_BASELINE_FROM_TOP = 32;
const BOTTOM_BASELINE_FROM_BOTTOM = 26;

export function pageNumberText(format: PageNumberFormat, number: number, total: number): string {
  switch (format) {
    case 'n':
      return String(number);
    case 'page':
      return `Page ${number}`;
    case 'of':
      return `Page ${number} of ${total}`;
  }
}

const FOOTER_SIZE = 12;
const FOOTER_LINE_HEIGHT = 15;
/** The last footer baseline sits this far above the bottom of the page, over the page-number band. */
const FOOTER_BASELINE_FROM_BOTTOM = 46;
/**
 * An average glyph is about 0.6 em wide, a monospace face's width and so a safe upper bound. Wrapping has to be decided without measuring text
 * (ADR-0015 — a browser and a server would measure differently), so it counts characters against
 * this estimate. Deterministic, so both surfaces break the same lines; a little conservative.
 */
const AVERAGE_GLYPH_EM = 0.6;

/**
 * The footer broken into lines: on its own `\n`s first, then by words to fit between the margins.
 * A single word wider than a line is left whole rather than chopped.
 */
export function footerLines(score: Score, spec: PageSpec): string[] {
  const footer = score.meta.footer;
  if (footer === undefined) return [];
  const perLine = Math.max(
    8,
    Math.floor((spec.width - spec.margin.left - spec.margin.right) / (FOOTER_SIZE * AVERAGE_GLYPH_EM)),
  );
  const lines: string[] = [];
  for (const paragraph of footer.text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter((w) => w !== '')) {
      if (line !== '' && line.length + 1 + word.length > perLine) {
        lines.push(line);
        line = word;
      } else {
        line = line === '' ? word : `${line} ${word}`;
      }
    }
    if (line !== '') lines.push(line);
  }
  return lines;
}

/**
 * Room the footer takes out of every page's body, beyond the bottom margin. Reserved on **every**
 * page whether or not it carries the footer, so a page's geometry never depends on which page it is
 * (the last page is not known while systems are still being placed). Only what overflows the
 * margin band is reserved: a one-line footer sits wholly inside it.
 */
export function footerReserve(score: Score, spec: PageSpec): number {
  const lines = footerLines(score, spec).length;
  if (lines === 0) return 0;
  const top = FOOTER_BASELINE_FROM_BOTTOM + (lines - 1) * FOOTER_LINE_HEIGHT + FOOTER_SIZE;
  return Math.max(0, top - spec.margin.bottom);
}

export function buildFurniture(
  score: Score,
  pageIndex: number,
  pageCount: number,
  spec: PageSpec,
): LayoutFurniture[] {
  const out: LayoutFurniture[] = [];
  const pages = score.meta.footer?.pages;
  if (pages !== undefined && (pages === 'all' || (pages === 'first' ? pageIndex === 0 : pageIndex === pageCount - 1))) {
    const lines = footerLines(score, spec);
    lines.forEach((text, at) => {
      out.push({
        role: 'footer',
        text,
        x: spec.width / 2,
        y: spec.height - FOOTER_BASELINE_FROM_BOTTOM - (lines.length - 1 - at) * FOOTER_LINE_HEIGHT,
        size: FOOTER_SIZE,
        align: 'center',
      });
    });
  }
  const numbers = spec.pageNumbers;
  if (numbers !== null && (pageIndex > 0 || numbers.first)) {
    const [vertical, horizontal] = numbers.position.split('-') as ['top' | 'bottom', 'left' | 'center' | 'right'];
    out.push({
      role: 'pageNumber',
      text: pageNumberText(numbers.format, pageIndex + 1, pageCount),
      x:
        horizontal === 'left'
          ? spec.margin.left
          : horizontal === 'center'
            ? spec.width / 2
            : spec.width - spec.margin.right,
      y: vertical === 'top' ? TOP_BASELINE_FROM_TOP : spec.height - BOTTOM_BASELINE_FROM_BOTTOM,
      size: FURNITURE_SIZE,
      align: horizontal,
    });
  }
  return out;
}
