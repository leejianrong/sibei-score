import type { Bar, BarItem, GraceNote, GraceValue, Score } from '@sibei/model';
import { createIdFactory, dur, makeScore, parsePitch } from '@sibei/model';
import { BarBuilder } from './builder.js';

/**
 * The grace-notes proofing chart (SIB2-185). Invented music, nothing from a real page.
 *
 * - bar 1: a slashed single grace (acciaccatura) before a quarter, then an unslashed one (appoggiatura) before a half
 * - bar 2: a grace with a sharp before a note, and a flat grace on a flat-key neighbour that needs none
 * - bar 3: three beamed sixteenth graces, slashed, on the first note of the bar after a barline
 * - bar 4: graces on a high note over ledger lines and a low one under them, then a final barline
 */
export function graceNotesChart(): Score {
  const ids = createIdFactory();
  const make = (number: number): BarBuilder => new BarBuilder(ids, { number });
  const bars: Bar[] = [
    make(1).chord(1, 'Cmaj7', 480).note('E5', dur(4)).note('G5', dur(2)).note('C5', dur(4)).build(),
    make(2).chord(1, 'A7', 480).note('C#5', dur(4)).note('E5', dur(4)).note('A4', dur(2)).build(),
    make(3).chord(1, 'Dm7', 480).note('D5', dur(4)).note('F5', dur(4)).note('A5', dur(2)).build(),
    new BarBuilder(ids, { number: 4, endBarline: 'final' }).chord(1, 'Cmaj7', 480).note('C6', dur(2)).note('A3', dur(2)).build(),
  ];
  let graceCount = 0;
  const grace = (pitch: string, value: GraceValue, slashed: boolean): GraceNote => {
    graceCount += 1;
    return { id: `grace-${graceCount}`, pitch: parsePitch(pitch), value, slashed, accidental: 'auto' };
  };
  const at = (bar: number, n: number): BarItem => {
    const item = bars[bar - 1]?.items[n - 1];
    if (item === undefined || item.kind !== 'note') throw new Error(`no note bar${bar}.n${n}`);
    return item;
  };
  const give = (bar: number, n: number, ...graces: GraceNote[]): void => {
    const item = at(bar, n);
    if (item.kind === 'note') item.graces = graces;
  };
  give(1, 1, grace('D5', 8, true));
  give(1, 2, grace('F5', 8, false));
  give(2, 2, grace('D#5', 8, false));
  give(2, 3, grace('Bb4', 16, true));
  give(3, 1, grace('C5', 16, true), grace('E5', 16, true), grace('F5', 16, true));
  give(4, 1, grace('B5', 8, true), grace('D6', 8, true));
  give(4, 2, grace('G3', 8, false));
  return makeScore({ id: 'grace-notes-chart', title: 'Grace Notes', composer: 'Proof chart', bars });
}
