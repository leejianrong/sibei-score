import { DEFAULT_MUSIC_FONT } from '@sibei/engrave';
import { grandStaffChart, nastyChart, pianoChordsChart, stackedChordsChart, twoVoiceChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import { HIT_MARGIN, MIN_HIT_PX, boxFor, hitMargin, hitTest, loadFont, pageItemBoxes } from '@sibei/ui';
import type { ItemBox } from '@sibei/ui';
import { describe, expect, it } from 'vitest';

/**
 * Hit slop (SIB2-275). The slop is a floor in **screen pixels**: a click within MIN_HIT_PX of a notehead selects the note
 * at any zoom, and the nearest note still wins when two are in reach. Pure geometry; the browser test clicks for real.
 */

const font = loadFont(DEFAULT_MUSIC_FONT);
/** Screen pixels per layout unit of a 780 px sheet over a 992-unit page, at a zoom (the app's own arithmetic). */
const pxPerUnit = (zoom: number): number => (780 * zoom) / 992.13;

describe('hitMargin', () => {
  it('never drops below the layout-unit margin, and grows as the sheet shrinks', () => {
    expect(hitMargin(undefined)).toBe(HIT_MARGIN);
    expect(hitMargin(100)).toBe(HIT_MARGIN);
    expect(hitMargin(pxPerUnit(1))).toBeCloseTo(MIN_HIT_PX / pxPerUnit(1), 6);
    expect(hitMargin(pxPerUnit(0.5))).toBeGreaterThan(hitMargin(pxPerUnit(1)));
    expect(hitMargin(0)).toBe(HIT_MARGIN);
  });
});

describe('a click a few pixels off a notehead', () => {
  const page = layout(nastyChart()).pages[0]!;
  const boxes = pageItemBoxes(page, font);
  const note = boxes.find((box) => box.kind === 'note')!;
  const middle = { x: note.x + note.width / 2, y: note.y + note.height / 2 };

  for (const zoom of [0.5, 1, 1.5]) {
    it(`selects the note 7 px to its left at ${zoom * 100}% zoom`, () => {
      const scale = pxPerUnit(zoom);
      const point = { x: note.x - 7 / scale, y: middle.y };
      expect(hitTest(boxes, point, hitMargin(scale))?.id).toBe(note.id);
    });

    it(`selects it 7 px above or below it at ${zoom * 100}% zoom`, () => {
      const scale = pxPerUnit(zoom);
      expect(hitTest(boxes, { x: middle.x, y: note.y - 7 / scale }, hitMargin(scale))?.id).toBe(note.id);
      expect(hitTest(boxes, { x: middle.x, y: note.y + note.height + 7 / scale }, hitMargin(scale))?.id).toBe(note.id);
    });
  }

  it('misses well past the slop, so the bar can still be clicked', () => {
    const scale = pxPerUnit(1);
    const near = boxes.filter((box) => box !== note);
    const point = { x: note.x - (MIN_HIT_PX + 40) / scale, y: note.y - (MIN_HIT_PX + 40) / scale };
    const reached = hitTest(boxes, point, hitMargin(scale));
    // Whatever it reaches (if anything) is not this note.
    expect(reached === null || near.includes(reached)).toBe(true);
  });

  it('is nothing at all in open space', () => {
    expect(hitTest(boxes, { x: page.width / 2, y: -500 }, hitMargin(pxPerUnit(0.5)))).toBeNull();
  });
});

describe('the nearest head wins when two are in reach', () => {
  it('between neighbouring notes, the closer one is chosen, at a generous slop', () => {
    const page = layout(nastyChart()).pages[0]!;
    const boxes = pageItemBoxes(page, font);
    const scale = pxPerUnit(0.5);
    const margin = hitMargin(scale);
    let checked = 0;
    for (let at = 0; at + 1 < boxes.length; at += 1) {
      const a = boxes[at]!;
      const b = boxes[at + 1]!;
      if (a.staffIndex !== b.staffIndex || a.voice !== b.voice || b.x <= a.x + a.width || b.x - a.x - a.width > margin) continue;
      const ay = a.y + a.height / 2;
      const left = { x: a.x + a.width + (b.x - a.x - a.width) * 0.25, y: ay };
      const right = { x: a.x + a.width + (b.x - a.x - a.width) * 0.75, y: b.y + b.height / 2 };
      if (hitTest(boxes, left, 0) !== null || hitTest(boxes, right, 0) !== null) continue;
      expect(hitTest(boxes, left, margin)?.id).toBe(a.id);
      expect(hitTest(boxes, right, margin)?.id).toBe(b.id);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('every head still resolves to itself under the widest slop (multi-staff, stacked chords)', () => {
  const margin = hitMargin(pxPerUnit(0.5));
  const charts: [string, ReturnType<typeof grandStaffChart>][] = [
    ['grand staff', grandStaffChart()],
    ['two voices', twoVoiceChart()],
    ['stacked chords', stackedChordsChart()],
    ['piano chords', pianoChordsChart()],
  ];
  it.each(charts)('%s', (_name, chart) => {
    let checked = 0;
    for (const page of layout(chart).pages) {
      const boxes = pageItemBoxes(page, font);
      for (const box of boxes) {
        const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        const hit = hitTest(boxes, centre, margin);
        expect(hit?.id).toBe(box.id);
        if (box.toneId !== undefined) {
          // Heads of a chord that overlap each other share a click; any other head is the one hit.
          const overlapped = boxes.some(
            (o: ItemBox) => o !== box && o.id === box.id && Math.abs(o.x - box.x) < box.width && Math.abs(o.y - box.y) < box.height,
          );
          if (!overlapped) expect(hit?.toneId).toBe(box.toneId);
        }
        expect(boxFor(boxes, box.id)).not.toBeNull();
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
