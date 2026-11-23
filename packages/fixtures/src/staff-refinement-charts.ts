import type { Score } from '@sibei/model';
import { createIdFactory, dur, makeStaffedScore, voiceOfView } from '@sibei/model';
import { BarBuilder } from './builder.js';

/**
 * Fixtures for SIB2-233 and SIB2-241, the multi-staff refinements of ADR-0041's slice 4: an ottava line on a staff that
 * is not the top one, and a clef change at a bar. Each is chosen so the proof shows the one thing.
 */

const BEAT = 480;
const q = dur(4);
const h = dur(2);

/**
 * A grand staff with an 8va over the right hand's high notes in bars 1-2 and an 8vb under the left hand's low ones in
 * bars 3-4, so each line is drawn on the staff it belongs to, with room reserved there and not above the top staff.
 */
export function ottavaStavesChart(): Score {
  const ids = createIdFactory();
  const make = (number: number): BarBuilder => new BarBuilder(ids, { number });
  const count = 4;
  const rh = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const b = make(n).chord(1, ['C', 'F', 'G7', 'C'][i]!, BEAT);
    return (n <= 2 ? b.note('C6', q).note('E6', q).note('G6', q).note('E6', q) : b.note('E5', h).note('C5', h)).build();
  });
  const lh = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const b = make(n);
    return (n <= 2 ? b.note('C3', h).note('G2', h) : b.note('C2', q).note('G1', q).note('C2', q).note('E2', q)).build();
  });
  const note = (views: typeof rh, bar: number, n: number): string => {
    const item = views[bar - 1]?.items.filter((x) => x.kind === 'note')[n - 1];
    if (item === undefined) throw new Error(`no note bar${bar}.n${n}`);
    return item.id;
  };
  const score = makeStaffedScore({
    id: 'ottava-staves',
    title: 'Ottava on Each Staff',
    composer: 'fixture',
    bars: rh,
    parts: [
      {
        name: 'Piano',
        instrument: 0,
        staves: [
          { clef: 'treble', bars: rh.map((view) => voiceOfView(view)) },
          { clef: 'bass', bars: lh.map((view) => voiceOfView(view)) },
        ],
      },
    ],
  });
  score.spanners = [
    { id: 'ottava-rh', kind: 'ottava', startId: note(rh, 1, 1), endId: note(rh, 2, 4), octaveShift: 'up' },
    { id: 'ottava-lh', kind: 'ottava', startId: note(lh, 3, 1), endId: note(lh, 4, 4), octaveShift: 'down' },
  ];
  return score;
}
