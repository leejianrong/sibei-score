import type { BarView, Dynamic, Score } from '@sibei/model';
import { createIdFactory, dur, makeScore, makeStaffedScore, voiceOfView } from '@sibei/model';
import { BarBuilder } from './builder.js';
import type { BarSpec } from './builder.js';

/**
 * The dynamics proofing charts (SIB2-274, ADR-0021 amendment).
 *
 * `dynamicsChart`, eight bars on two lines:
 * - bar 1: mf on the first note, a crescendo from the second that stops short of bar 2's f
 * - bar 2: a diminuendo from the second note to bar 3's first note, which carries p
 * - bar 3: a dynamic (mp) on a rest
 * - bar 4 into bar 5: a crescendo that **crosses the system break**, so it draws as two halves
 * - bar 5: sfz and fp, the two marks that are not a plain level
 * - bar 6: stems-up low notes with a dynamic, under an 8vb line, so the row sits below the ottava
 * - bar 5 also has a slur forced below, over the sfz and fp, to see a below-slur against the row
 * - bar 7: a slur over notes that carry dynamics
 * - bar 8: ppp, rfz, sf and fff on eighth notes, the widest glyphs close together
 *
 * `dynamicsStavesChart`: a grand staff where each staff has its own row (the right hand mf and a crescendo, the left
 * hand p and a diminuendo), so the room reserved under the top staff is seen between the staves.
 */
function mark(bars: BarView[], bar: number, n: number, dynamic: Dynamic): void {
  const item = bars[bar - 1]?.items[n - 1];
  if (item === undefined) throw new Error(`no item bar${bar}.n${n}`);
  item.dynamic = dynamic;
}

function idAt(bars: BarView[], bar: number, n: number): string {
  const item = bars[bar - 1]?.items[n - 1];
  if (item === undefined) throw new Error(`no item bar${bar}.n${n}`);
  return item.id;
}

export function dynamicsChart(): Score {
  const ids = createIdFactory();
  const make = (spec: BarSpec): BarBuilder => new BarBuilder(ids, spec);
  const bars: BarView[] = [
    make({ number: 1 }).chord(1, 'Cmaj7', 480).note('C5', dur(4)).note('D5', dur(4)).note('E5', dur(4)).note('F5', dur(4)).build(),
    make({ number: 2 }).chord(1, 'Dm7', 480).note('G5', dur(4)).note('A5', dur(4)).note('G5', dur(4)).note('F5', dur(4)).build(),
    make({ number: 3 }).chord(1, 'G7', 480).note('D5', dur(4)).rest(dur(4)).note('E5', dur(2)).build(),
    make({ number: 4 }).chord(1, 'Cmaj7', 480).note('E5', dur(2)).note('G5', dur(2)).build(),
    make({ number: 5 }).chord(1, 'Am7', 480).note('A5', dur(4)).note('F5', dur(4)).note('E5', dur(4)).note('D5', dur(4)).build(),
    make({ number: 6 }).chord(1, 'Fmaj7', 480).note('A3', dur(4)).note('C4', dur(4)).note('E4', dur(4)).note('F3', dur(4)).build(),
    make({ number: 7 }).chord(1, 'Bb7', 480).note('F5', dur(4)).note('G5', dur(4)).note('A5', dur(4)).note('Bb5', dur(4)).build(),
    make({ number: 8, endBarline: 'final' })
      .chord(1, 'Cmaj7', 480)
      .note('C5', dur(8)).note('D5', dur(8)).note('E5', dur(8)).note('F5', dur(8))
      .note('G5', dur(8)).note('F5', dur(8)).note('E5', dur(8)).note('D5', dur(8))
      .build(),
  ];
  mark(bars, 1, 1, 'mf');
  mark(bars, 2, 1, 'f');
  mark(bars, 3, 1, 'p');
  mark(bars, 3, 2, 'mp');
  mark(bars, 5, 3, 'sfz');
  mark(bars, 5, 4, 'fp');
  mark(bars, 6, 1, 'mp');
  mark(bars, 6, 3, 'mf');
  mark(bars, 7, 1, 'f');
  mark(bars, 7, 4, 'ff');
  mark(bars, 8, 1, 'ppp');
  mark(bars, 8, 3, 'rfz');
  mark(bars, 8, 5, 'sf');
  mark(bars, 8, 7, 'fff');
  const score = makeScore({ id: 'dynamics-chart', title: 'Dynamics', composer: 'Proof chart', bars });
  const at = (bar: number, n: number): string => idAt(bars, bar, n);
  score.spanners = [
    { id: 'hairpin-1', kind: 'hairpin', startId: at(1, 2), endId: at(2, 1), hairpin: 'crescendo' },
    { id: 'hairpin-2', kind: 'hairpin', startId: at(2, 2), endId: at(3, 1), hairpin: 'diminuendo' },
    { id: 'hairpin-3', kind: 'hairpin', startId: at(4, 1), endId: at(5, 2), hairpin: 'crescendo' },
    { id: 'ottava-1', kind: 'ottava', startId: at(6, 1), endId: at(6, 4), octaveShift: 'down' },
    { id: 'slur-1', kind: 'slur', startId: at(7, 1), endId: at(7, 4) },
    { id: 'slur-2', kind: 'slur', startId: at(5, 1), endId: at(5, 4), placement: 'below' },
  ];
  return score;
}

export function dynamicsStavesChart(): Score {
  const ids = createIdFactory();
  const make = (spec: BarSpec): BarBuilder => new BarBuilder(ids, spec);
  const right: BarView[] = [
    make({ number: 1 }).chord(1, 'C', 480).note('E5', dur(4)).note('G5', dur(4)).note('E5', dur(4)).note('C5', dur(4)).build(),
    make({ number: 2, endBarline: 'final' }).chord(1, 'G7', 480).note('D5', dur(2)).note('B4', dur(2)).build(),
  ];
  const left: BarView[] = [
    make({ number: 1 }).note('C3', dur(2)).note('G2', dur(2)).build(),
    make({ number: 2, endBarline: 'final' }).note('G2', dur(2)).note('D3', dur(2)).build(),
  ];
  mark(right, 1, 1, 'mf');
  mark(right, 2, 1, 'f');
  mark(left, 1, 1, 'p');
  mark(left, 2, 2, 'pp');
  const score = makeStaffedScore({
    id: 'dynamics-staves',
    title: 'Dynamics on staves',
    composer: 'Proof chart',
    bars: right,
    parts: [
      {
        name: 'Piano',
        instrument: 0,
        staves: [
          { clef: 'treble', bars: right.map((view) => voiceOfView(view)) },
          { clef: 'bass', bars: left.map((view) => voiceOfView(view)) },
        ],
      },
    ],
  });
  score.spanners = [
    { id: 'hairpin-1', kind: 'hairpin', startId: idAt(right, 1, 2), endId: idAt(right, 2, 1), hairpin: 'crescendo' },
    { id: 'hairpin-2', kind: 'hairpin', startId: idAt(left, 1, 2), endId: idAt(left, 2, 2), hairpin: 'diminuendo' },
  ];
  return score;
}
