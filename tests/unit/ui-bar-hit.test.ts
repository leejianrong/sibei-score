import { aabaChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import { barAt, barBoxFor, pageBarBoxes } from '@sibei/ui';
import { describe, expect, it } from 'vitest';

/**
 * Mapping a click to a whole bar (V7c) — the geometry behind "click the bar or its barline".
 *
 * The `aaba-chart` fixture is used because it has a pickup and 32 numbered bars, so there is a bar
 * on every system and the pickup to check the box layout against. Like the note hit-test, every
 * assertion derives from whatever bars the fixture has rather than naming pixel positions.
 */

describe('bar hit-testing', () => {
  const result = layout(aabaChart());

  it('boxes every bar on every system, the pickup included', () => {
    const numbers = new Set<number>();
    for (const page of result.pages) {
      for (const box of pageBarBoxes(page)) numbers.add(box.barNumber);
    }
    // 0 (pickup) through 32.
    for (let n = 0; n <= 32; n += 1) expect(numbers.has(n)).toBe(true);
  });

  it('resolves the centre of every bar box to its own bar', () => {
    let checked = 0;
    for (const page of result.pages) {
      const boxes = pageBarBoxes(page);
      for (const box of boxes) {
        const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        expect(barAt(boxes, centre)?.barNumber).toBe(box.barNumber);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('resolves a click on a bar edge (a barline) to the bar it bounds', () => {
    const page = result.pages[0]!;
    const boxes = pageBarBoxes(page);
    const bar = boxes.find((b) => b.barNumber === 1)!;
    // The right edge of bar 1 is its closing barline; a click there still lands in bar 1.
    const onBarline = { x: bar.x + bar.width - 0.01, y: bar.y + bar.height / 2 };
    expect(barAt(boxes, onBarline)?.barNumber).toBe(1);
  });

  it('returns null well above the staff (the title, the chord band) and far below it', () => {
    const page = result.pages[0]!;
    const boxes = pageBarBoxes(page);
    const bar = boxes.find((b) => b.barNumber === 1)!;
    expect(barAt(boxes, { x: bar.x + 1, y: bar.y - 200 })).toBeNull();
    expect(barAt(boxes, { x: bar.x + 1, y: bar.y + bar.height + 200 })).toBeNull();
  });

  it('finds a known bar box for redrawing the selection after a repaint', () => {
    const page = result.pages[0]!;
    const boxes = pageBarBoxes(page);
    expect(barBoxFor(boxes, 1)?.barNumber).toBe(1);
    expect(barBoxFor(boxes, 999)).toBeNull();
  });
});
