import type { Score } from '@sibei/model';
import { createIdFactory, dur, makeScore } from '@sibei/model';
import { BarBuilder } from './builder.js';

/**
 * Spacing under pressure (SIB2-153): the bars most likely to put glyphs on top of one another. Accidentals
 * on consecutive sixteenths, a chromatic run through ledger lines, a rest between close notes, a second
 * apart in a beamed group, and a dotted rhythm with accidentals. Every bar carries a chord so the chord
 * row is judged against the same crowding.
 */
export function denseSpacingChart(): Score {
  const ids = createIdFactory();
  const beat = 480;
  const s = dur(16);
  const e = dur(8);
  const bar = (number: number): BarBuilder => new BarBuilder(ids, { number });

  const light = (number: number, chord: string, pitch: string): BarBuilder =>
    bar(number).chord(1, chord, beat).note(pitch, dur(4)).note(pitch, dur(4)).note(pitch, dur(2));

  const bars = [
    // Accidentals on every sixteenth, then four eighths: the densest bar here, with three light ones to give.
    bar(1)
      .chord(1, 'F#7alt', beat)
      .note('F#5', s).note('G#5', s).note('Ab5', s).note('Bb5', s)
      .note('C#5', s).note('D#5', s).note('Eb5', s).note('E5', s)
      .note('F#5', e).note('G5', e).note('A#4', e).note('B4', e)
      .build(),
    light(2, 'Bmaj7', 'B4').build(),
    light(3, 'E7', 'E5').build(),
    light(4, 'Amaj7', 'A4').build(),

    // A diatonic-then-chromatic run through the ledger lines above and below.
    bar(5)
      .chord(1, 'Bbmaj7#11', beat)
      .note('A5', e).note('B5', e).note('C6', e).note('D6', e)
      .note('C4', e).note('B3', e).note('A3', e).note('G3', e)
      .build(),
    // A rest wedged between close notes, a second apart, and two chords over four notes.
    bar(6)
      .chord(1, 'Dm7', beat)
      .chord(3, 'G7b9', beat)
      .note('E5', e).note('F5', e).rest(e).note('G5', e)
      .note('F5', dur(4)).note('G5', e).note('A5', e)
      .build(),
    // Dotted rhythm with accidentals and a second inside a beam group.
    bar(7)
      .chord(1, 'C#m7b5', beat)
      .chord(3, 'F#7#9', beat)
      .note('C#5', dur(8, 1)).note('D#5', s).note('E5', e).note('F5', e)
      .note('G#5', dur(8, 1)).note('A5', s).note('Bb5', e).note('B5', e)
      .build(),
    light(8, 'Bmaj7', 'B4').build(),
  ];
  return makeScore({ id: 'score-dense-spacing', title: 'Dense spacing', bars });
}
