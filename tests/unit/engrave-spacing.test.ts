import type { PlacedItem } from '@sibei/engrave';
import {
  ACCIDENTAL_GAP,
  SPACING,
  accidentalGlyph,
  durationSpace,
  musicFontNamed,
  noteheadFor,
  placeItems,
} from '@sibei/engrave';
import { beamingChart, invalidBarChart, nastyChart } from '@sibei/fixtures';
import type { LayoutBar } from '@sibei/layout';
import { layout } from '@sibei/layout';
import type { Score } from '@sibei/model';
import { dur } from '@sibei/model';
import { describe, expect, it } from 'vitest';

/**
 * Within-bar spacing: what a note asks for on grounds of time, what its glyphs need
 * whatever the tempo, and how the two are reconciled.
 *
 * The collision test below is the one that matters. The V1b spike placed onsets in
 * proportion to time and nothing else, and bar 6's natural landed on top of the note
 * before it — which nobody's test noticed and the first person to look at the image saw
 * immediately. It is asserted here across every fixture rather than for the one bar that
 * happened to be caught.
 */

const font = musicFontNamed();

function bars(score: Score): LayoutBar[] {
  return layout(score)
    .pages.flatMap((page) => page.systems)
    .flatMap((system) => system.bars);
}

/** The right-hand edge of everything a placed note draws horizontally. */
function rightEdge(placed: PlacedItem): number {
  const { item } = placed;
  if (item.kind === 'rest') return placed.x + SPACING.restPlaceholder;
  const notehead = font.width(noteheadFor(item.duration));
  const dots = item.duration.dots * (font.width('augmentationDot') + 3);
  return placed.x + notehead + dots;
}

describe('what a duration asks for', () => {
  it('grows with the note, but slower than the note does', () => {
    const quarter = durationSpace(dur(4));
    const half = durationSpace(dur(2));
    const sixteenth = durationSpace(dur(16));

    expect(half).toBeGreaterThan(quarter);
    expect(quarter).toBeGreaterThan(sixteenth);

    // The whole point. Strict proportion would give a sixteenth a quarter of a quarter's
    // room and crush it; the exponent gives it appreciably more.
    expect(sixteenth / quarter).toBeGreaterThan(0.25);
    expect(sixteenth / quarter).toBeLessThan(0.5);
    // And a half gets less than twice a quarter, so long notes do not strand the bar.
    expect(half / quarter).toBeLessThan(2);
  });

  it('counts a dot as the time it adds', () => {
    expect(durationSpace(dur(2, 1))).toBeGreaterThan(durationSpace(dur(2)));
    expect(durationSpace(dur(2, 1))).toBeCloseTo(durationSpace(dur(4)) * 3 ** SPACING.durationExponent, 6);
  });
});

describe('glyphs never collide', () => {
  /** Name, score, and the number of adjacent pairs it must actually produce. */
  const fixtures: [string, Score, number][] = [
    ['nasty-chart', nastyChart(), 43],
    ['beaming', beamingChart(), 13],
    ['invalid-bars', invalidBarChart(), 6],
  ];

  for (const [name, score, pairs] of fixtures) {
    it(`leaves clear air between every pair of adjacent notes in ${name}`, () => {
      let checked = 0;
      for (const bar of bars(score)) {
        const placed = placeItems(font, bar);
        for (let index = 1; index < placed.length; index += 1) {
          const previous = placed[index - 1];
          const current = placed[index];
          if (previous === undefined || current === undefined) continue;
          expect(current.leftEdge).toBeGreaterThanOrEqual(rightEdge(previous));
          checked += 1;
        }
      }
      // Without this the loop could pass by never running.
      expect(checked).toBe(pairs);
    });
  }

  it('gives bar 6\'s natural room of its own, which is where this started', () => {
    const bar6 = bars(nastyChart()).find((bar) => bar.barNumber === 6);
    if (bar6 === undefined) throw new Error('no bar 6');
    const placed = placeItems(font, bar6);

    const [first, second] = placed;
    if (first === undefined || second === undefined) throw new Error('bar 6 is short');

    // The second sixteenth is the A natural. Its accidental sits in reserved space:
    // the glyph starts after the first notehead ends, not on top of it.
    const accidental = second.item.kind === 'note' ? second.item.accidentalGlyph : null;
    expect(accidental).toBe(0);
    if (accidental === null) throw new Error('bar 6 lost its natural');

    const accidentalLeft = second.x - ACCIDENTAL_GAP - font.width(accidentalGlyph(accidental));
    expect(accidentalLeft).toBeGreaterThanOrEqual(rightEdge(first));
    expect(second.leftEdge).toBeCloseTo(accidentalLeft, 6);
  });
});

describe('a bar that does not fill the meter', () => {
  it('leaves the shortfall visible at the end rather than justifying across it', () => {
    // ADR-0013: stored, flagged, drawn as written. Two quarters spread across a whole
    // 4/4 bar read as two halves, which is not what the score says.
    const all = bars(invalidBarChart());
    const short = all.find((bar) => bar.metrics.status === 'under');
    const exact = all.find((bar) => bar.metrics.status === 'exact');
    if (short === undefined || exact === undefined) throw new Error('fixture changed');

    const spread = (bar: LayoutBar): number => {
      const placed = placeItems(font, bar);
      const first = placed[0];
      const last = placed[placed.length - 1];
      if (first === undefined || last === undefined) return 0;
      return (last.x - first.x) / bar.width;
    };

    // The short bar holds two of the four quarters the exact bar holds, so its notes
    // must occupy a visibly smaller share of an equally wide box.
    expect(spread(short)).toBeLessThan(spread(exact) * 0.6);
  });

  it('still fills a pickup, which is short on purpose', () => {
    const pickup = bars(nastyChart()).find((bar) => bar.isPickup);
    if (pickup === undefined) throw new Error('no pickup');
    const placed = placeItems(font, pickup);
    const last = placed[placed.length - 1];
    if (last === undefined) throw new Error('empty pickup');
    // Its box was sized to its contents, so the last note sits well into it.
    expect(last.x).toBeGreaterThan(pickup.x + pickup.width * 0.4);
  });
});

describe('the bar box', () => {
  it('starts the music clear of the barline and the prefix', () => {
    for (const bar of bars(nastyChart())) {
      const first = placeItems(font, bar)[0];
      if (first === undefined) continue;
      expect(first.leftEdge).toBeCloseTo(bar.x + bar.prefixWidth + SPACING.leftPad, 6);
    }
  });

  it('keeps every note inside its own bar', () => {
    for (const bar of bars(nastyChart())) {
      for (const placed of placeItems(font, bar)) {
        expect(placed.leftEdge).toBeGreaterThanOrEqual(bar.x);
        expect(rightEdge(placed)).toBeLessThanOrEqual(bar.x + bar.width);
      }
    }
  });
});
