import type { Score } from '@sibei/model';
import { createIdFactory, dur, makeStaffedScore, voiceOfView } from '@sibei/model';
import { BarBuilder } from './builder.js';

/**
 * What runs through every staff or hangs on a lower one (slice 4 of ADR-0041, SIB2-228): a piano's grand staff in a sharp
 * key with a repeat around bars 1 to 3 and a final bar, articulations and a fermata on the left hand, a tied half note
 * and a dotted note, and rests on the bass staff, so the barlines, repeat dots and marks are each seen on a staff that is
 * not the top one.
 */

const BEAT = 480;
const q = dur(4);
const h = dur(2);
const e = dur(8);

export function staffFurnitureChart(): Score {
  const ids = createIdFactory();
  const count = 4;
  const bar = (n: number): BarBuilder => {
    const spec: { number: number; startBarline?: 'repeat-start'; endBarline?: 'repeat-end' | 'final' } = { number: n };
    if (n === 1) spec.startBarline = 'repeat-start';
    if (n === 3) spec.endBarline = 'repeat-end';
    if (n === 4) spec.endBarline = 'final';
    return new BarBuilder(ids, spec);
  };
  const right = (n: number): BarBuilder => {
    const b = bar(n).chord(1, ['A', 'F#m7', 'Bm7', 'E7'][n - 1]!, BEAT);
    return n === 4 ? b.note('A4', dur(1)) : b.note('C#5', q).note('E5', q).note('A4', dur(4, 1)).note('B4', e);
  };
  const left = (n: number): BarBuilder => {
    const b = new BarBuilder(ids, { number: n });
    switch (n) {
      case 1:
        return b.note('A2', q).note('E3', q).note('A2', q).note('E3', q);
      case 2:
        return b.note('F#2', h, 'start').note('F#2', q, 'stop').rest(q);
      case 3:
        return b.rest(dur(1));
      default:
        return b.note('A2', dur(1));
    }
  };
  const rightBars = Array.from({ length: count }, (_, index) => right(index + 1).build());
  const leftBars = Array.from({ length: count }, (_, index) => left(index + 1).build());
  // Marks on the left hand: staccato on the first two notes of bar 1, an accent on bar 2's first note, a fermata at the end.
  for (const index of [0, 1]) {
    const item = leftBars[0]?.items[index];
    if (item?.kind === 'note') item.articulations = ['staccato'];
  }
  const tied = leftBars[1]?.items[0];
  if (tied?.kind === 'note') tied.articulations = ['accent'];
  const last = leftBars[3]?.items[0];
  if (last !== undefined) last.fermata = true;
  return makeStaffedScore({
    id: 'staff-furniture',
    title: 'Staff Furniture',
    composer: 'fixture',
    key: { tonic: 'A', alter: 0, mode: 'major' },
    bars: rightBars,
    parts: [
      {
        name: 'Piano',
        instrument: 0,
        staves: [
          { clef: 'treble', bars: rightBars.map((view) => voiceOfView(view)) },
          { clef: 'bass', bars: leftBars.map((view) => voiceOfView(view)) },
        ],
      },
    ],
  });
}
