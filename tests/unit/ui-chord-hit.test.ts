import { DEFAULT_MUSIC_FONT } from '@sibei/engrave';
import { nastyChart } from '@sibei/fixtures';
import { beatSlotAt, chordAt, loadFont, pageChordBoxes, renderScorePages } from '@sibei/ui';
import { describe, expect, it } from 'vitest';

/**
 * Chord hit-testing (V5e), the counterpart of `ui-hit-test.test.ts` for notes. `nastyChart` is
 * used because it already carries a spread of chords — `Ebmaj7`, `Bb13#11`, `F#m7b5`, `Ab/Eb`,
 * `N.C.` — so nothing here has to author a special fixture. Every assertion derives from whatever
 * chords the fixture happens to have, the same discipline the note test keeps.
 */

describe('chord hit-testing', () => {
  const score = nastyChart();
  const font = loadFont(DEFAULT_MUSIC_FONT);
  const pages = renderScorePages(score, { paper: 'a4' }, { font: DEFAULT_MUSIC_FONT });
  const page = pages[0]!.layout;
  const boxes = pageChordBoxes(page, font);

  it('boxes every chord on the page, addressing each by its beat', () => {
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      expect(box.addr).toMatch(/^bar\d+\.beat/);
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
    }
  });

  it('resolves the centre of every chord box back to that chord', () => {
    for (const box of boxes) {
      const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      expect(chordAt(boxes, centre)?.chordId).toBe(box.chordId);
    }
  });

  it('finds no chord in the staff below the band', () => {
    const system = page.systems[0]!;
    // A point on the staff itself is well below where chords sit.
    expect(chordAt(boxes, { x: system.x + system.width / 2, y: system.staveY + 5 })).toBeNull();
  });

  it('resolves a click in the band above a bar to a beat there (Q32)', () => {
    const system = page.systems[0]!;
    const bar = system.bars[0]!;
    const bandY = system.staveY - system.chordBaselineOffset - 4;
    // Two thirds across the bar's music area — a beat in the second half.
    const x = bar.x + bar.prefixWidth + (bar.width - bar.prefixWidth) * 0.66;
    const slot = beatSlotAt(page, { x, y: bandY }, score.meta.time);
    expect(slot).not.toBeNull();
    expect(slot?.barNumber).toBe(bar.barNumber);
    expect(slot?.beat).toBeGreaterThanOrEqual(1);
    expect(slot?.beat).toBeLessThanOrEqual(score.meta.time.beats);
  });

  it('resolves no beat slot from a click down on the staff', () => {
    const system = page.systems[0]!;
    const bar = system.bars[0]!;
    expect(beatSlotAt(page, { x: bar.x + bar.width / 2, y: system.staveY + 20 }, score.meta.time)).toBeNull();
  });
});
