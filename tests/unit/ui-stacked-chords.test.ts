import { DEFAULT_MUSIC_FONT } from '@sibei/engrave';
import { pianoChordsChart, stackedChordsChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import { parseAddress, formatAddress } from '@sibei/model';
import { boxFor, hitTest, loadFont, pageItemBoxes } from '@sibei/ui';
import { chordToneAddress, thirdFrom } from '../../packages/ui/src/lib/staff-edits.js';
import { describe, expect, it } from 'vitest';

/** Stacked chords in the browser's hit-testing and edit helpers (SIB2-243). */

describe('hit-testing a stacked chord', () => {
  const font = loadFont(DEFAULT_MUSIC_FONT);

  it('gives every head of a chord a box of its own, all addressing the carrying note', () => {
    for (const chart of [stackedChordsChart(), pianoChordsChart()]) {
      for (const page of layout(chart).pages) {
        const boxes = pageItemBoxes(page, font);
        const toned = boxes.filter((box) => box.toneId !== undefined);
        expect(toned.length).toBeGreaterThan(0);
        // Each head's centre hits that head, and the head's pitch is the one that was drawn there.
        for (const box of toned) {
          const hit = hitTest(boxes, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
          expect(hit?.id).toBe(box.id);
          // Two heads that overlap each other (a cluster that no stem side can separate) share the click; any other
          // head is the one hit.
          const overlapped = toned.some(
            (other) =>
              other !== box && other.id === box.id && Math.abs(other.x - box.x) < box.width && Math.abs(other.y - box.y) < box.height,
          );
          if (!overlapped) expect(hit?.toneId).toBe(box.toneId);
        }
      }
    }
  });

  it('outlines a chord as the union of its heads', () => {
    const page = layout(stackedChordsChart()).pages[0]!;
    const boxes = pageItemBoxes(page, font);
    const triad = boxes.filter((box) => box.toneId !== undefined && box.id === boxes.find((b) => b.toneId !== undefined)!.id);
    const outline = boxFor(boxes, triad[0]!.id)!;
    expect(triad.length).toBe(3);
    expect(outline.y).toBe(Math.min(...triad.map((b) => b.y)));
    expect(outline.y + outline.height).toBe(Math.max(...triad.map((b) => b.y + b.height)));
  });
});

describe('the inspector helpers', () => {
  it('finds a diatonic third above and below', () => {
    expect(thirdFrom('C4', 1)).toBe('E4');
    expect(thirdFrom('C4', -1)).toBe('A3');
    expect(thirdFrom('B4', 1)).toBe('D5');
    expect(thirdFrom('F#4', 1)).toBe('A4');
  });

  it('builds the address `note rm` takes for one pitch, and the model reads it back', () => {
    const address = chordToneAddress('s2.v1.', 3, 2, 'E4');
    expect(address).toBe('s2.v1.bar3.beat2.E4');
    expect(parseAddress(address)).toMatchObject({ form: 'beat', bar: 3, beat: 2, tone: 'E4', staff: 2, voice: 1 });
    expect(formatAddress(parseAddress(address))).toBe(address);
  });
});
