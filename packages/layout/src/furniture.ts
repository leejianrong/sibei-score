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

export type LayoutFurnitureRole = 'pageNumber';

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

export function buildFurniture(
  pageIndex: number,
  pageCount: number,
  spec: PageSpec,
): LayoutFurniture[] {
  const out: LayoutFurniture[] = [];
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
