import type { BarView, NavKind, Score } from '@sibei/model';
import { createIdFactory, dur, makeScore, makeSection } from '@sibei/model';
import { BarBuilder } from './builder.js';
import type { BarSpec } from './builder.js';

/**
 * The navigation proofing chart (SIB2-175, ADR-0021 amendment): one of each mark, placed the way a Real Book page does.
 *
 * - bar 1: a segno at the bar's start, under a rehearsal box (the two share a bar: the sign's row is above the box's)
 * - bar 2: Fine, right-aligned at the bar end
 * - bar 4: To Coda
 * - bar 5: a rehearsal box and no mark, so a line without marks sits beside marked ones
 * - bar 8: D.S. al Coda, closing the form with a double barline
 * - bar 9: a coda sign at the start of the C / Coda section's boxes
 * - bar 12: D.C. al Fine on the last bar
 */
const NAV: Record<number, NavKind[]> = {
  1: ['segno'],
  2: ['fine'],
  4: ['to-coda'],
  8: ['ds-al-coda'],
  9: ['coda'],
  12: ['dc-al-fine'],
};

export function navigationChart(): Score {
  const ids = createIdFactory();
  const make = (spec: BarSpec): BarBuilder => new BarBuilder(ids, spec);
  const chords = ['Cmaj7', 'Am7', 'Dm7', 'G7'];
  const bars: BarView[] = [];
  for (let n = 1; n <= 12; n += 1) {
    const spec: BarSpec = {
      number: n,
      ...(n === 8 ? { endBarline: 'double' as const } : {}),
      ...(n === 12 ? { endBarline: 'final' as const } : {}),
    };
    const bar = make(spec)
      .chord(1, chords[(n - 1) % 4] ?? 'Cmaj7', 480)
      .note(n % 2 === 0 ? 'C5' : 'E5', dur(2))
      .note('G4', dur(2))
      .build();
    const nav = NAV[n];
    bars.push(nav === undefined ? bar : { ...bar, nav });
  }
  return makeScore({
    id: 'navigation-chart',
    title: 'Navigation',
    composer: 'Proof chart',
    key: { tonic: 'C', alter: 0, mode: 'major' },
    time: { beats: 4, beatValue: 4 },
    bars,
    sections: [
      makeSection({ id: ids.next('section'), startBar: 1, letter: 'A', name: null }),
      makeSection({ id: ids.next('section'), startBar: 5, letter: 'B', name: null }),
      makeSection({ id: ids.next('section'), startBar: 9, letter: 'C', name: 'Coda' }),
    ],
  });
}
