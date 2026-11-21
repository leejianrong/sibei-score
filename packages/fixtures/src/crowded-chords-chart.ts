import type { Score } from '@sibei/model';
import { createIdFactory, dur, makeScore } from '@sibei/model';
import { BarBuilder } from './builder.js';

/**
 * A crowded but playable chart: four short symbols to a bar (ii-V-I turnarounds), two long ones to a
 * bar, a bar with a chord on a beat that has no note, and eighth-note bars under all of it.
 */
export function crowdedChordsChart(): Score {
  const ids = createIdFactory();
  const beat = 480;
  const short = [['Dm7', 'G7', 'Cm7', 'F7'], ['Bbm7', 'Eb7', 'Abmaj7', 'Db7'], ['Em7b5', 'A7b9', 'Dm7', 'G7']];
  const long = [['F#m7b5', 'B7alt'], ['Ebmaj7#11', 'Ab13'], ['C7b9b13', 'Fmaj7#11']];
  const bars = Array.from({ length: 12 }, (_, n) => {
    const bar = new BarBuilder(ids, { number: n + 1 });
    if (n % 2 === 0) {
      (short[(n / 2) % short.length] ?? []).forEach((name, b) => bar.chord(b + 1, name, beat));
    } else {
      (long[(n >> 1) % long.length] ?? []).forEach((name, b) => bar.chord(b * 2 + 1, name, beat));
    }
    if (n % 3 === 0) for (let i = 0; i < 8; i += 1) bar.note('C5', dur(8));
    else if (n % 3 === 1) bar.note('C5', dur(2)).note('D5', dur(2));
    else bar.note('C5', dur(1));
    return bar.build();
  });
  return makeScore({ id: 'crowded', title: 'Crowded', bars });
}
