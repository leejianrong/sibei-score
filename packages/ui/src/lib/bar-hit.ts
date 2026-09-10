import { BOTTOM_LINE, TOP_LINE, positionY } from '@sibei/engrave';
import { STAFF_SPACE } from '@sibei/layout';
import type { LayoutPage } from '@sibei/layout';
import type { Id } from '@sibei/model';
import type { Point } from './hit-test.js';

/**
 * Mapping a click to a whole bar — V7c, so the browser can edit a bar's structure (its section,
 * barlines and endings) the way the CLI's `section`/`barline`/`ending` verbs do.
 *
 * Like `hit-test.js` and `chord-hit.js`, this is **not a second opinion about geometry**: a bar's
 * `x`/`width` are the layout's own, and the staff band a click has to fall in is `positionY` of the
 * top and bottom staff lines — the exact functions the engraver draws the staff from (ADR-0015). It
 * never measures anything and never looks inside the SVG.
 *
 * A bar owns the staff region under it, edge to edge, so a click on a barline (which sits on a bar
 * edge) selects the bar it bounds. Notes and the chord band are hit-tested first in the caller, so
 * this only ever gets a click that landed on bare staff or a barline — exactly "click the bar or its
 * barline".
 */

export interface BarBox {
  barNumber: number;
  barId: Id;
  /** Layout units — the same space as the page's SVG `viewBox`. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How far above the top line and below the bottom line still counts as the bar's band. */
const BAND_MARGIN = STAFF_SPACE;

/** Every bar on a page, boxed as the staff region the engraver drew under it. */
export function pageBarBoxes(page: LayoutPage): BarBox[] {
  const boxes: BarBox[] = [];
  for (const system of page.systems) {
    const top = positionY(TOP_LINE, system.staveY) - BAND_MARGIN;
    const bottom = positionY(BOTTOM_LINE, system.staveY) + BAND_MARGIN;
    for (const bar of system.bars) {
      boxes.push({
        barNumber: bar.barNumber,
        barId: bar.barId,
        x: bar.x,
        y: top,
        width: bar.width,
        height: bottom - top,
      });
    }
  }
  return boxes;
}

function contains(box: BarBox, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

/** The bar whose staff band a point falls in, or null when the click missed every bar. */
export function barAt(boxes: readonly BarBox[], point: Point): BarBox | null {
  return boxes.find((box) => contains(box, point)) ?? null;
}

/** The box for a bar number already known — after a fresh render, to redraw the selection outline. */
export function barBoxFor(boxes: readonly BarBox[], barNumber: number): BarBox | null {
  return boxes.find((box) => box.barNumber === barNumber) ?? null;
}
