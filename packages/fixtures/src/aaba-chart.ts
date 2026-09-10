import type { Bar, Ending, Score } from '@sibei/model';
import { createIdFactory, dur, makeScore, makeSection } from '@sibei/model';
import { BarBuilder } from './builder.js';
import type { BarSpec } from './builder.js';

/**
 * The V7 demo chart: a 32-bar AABA head with a pickup, rehearsal letters, and a repeated A
 * section with 1st and 2nd endings. It exists to prove the structure slice end to end — every
 * feature V7 added is here, and each is visible from a music stand if it is wrong:
 *
 * - a **pickup** (bar 0), which must sit before bar 1 without taking a four-bar grid slot
 * - four eight-bar **sections** at bars 1, 9, 17 and 25, each carrying a **rehearsal letter**
 *   (A, B, C, D) — a line break must fall at every one of them
 * - a **repeat** around the first A (bars 1–8), with a **1st ending** on bar 7 closed by a
 *   `repeat-end`, and a **2nd ending** on bar 8 — the two must render over exactly those bars
 * - a **double barline** closing the second A (bar 16) and a **final barline** ending the chart
 *
 * The music itself is deliberately plain — one chord and a couple of notes a bar — because the
 * point of this fixture is the structure, and a busy melody would only make the endings and
 * barlines harder to see when proofing.
 */

const BEAT = 480;
const FORM = ['A', 'A', 'Bridge', 'A'] as const;
const LETTERS = ['A', 'B', 'C', 'D'] as const;

/** A plain bar: a chord on beat 1 and two half notes, so every bar has ink without noise. */
function fill(bars: Bar[], make: (spec: BarSpec) => BarBuilder, number: number, chord: string, spec: Partial<BarSpec> = {}): void {
  const high = number % 2 === 0 ? 'C5' : 'E5';
  bars.push(
    make({ number, ...spec }).chord(1, chord, BEAT).note(high, dur(2)).note('G4', dur(2)).build(),
  );
}

export function aabaChart(): Score {
  const ids = createIdFactory();
  const make = (spec: BarSpec): BarBuilder => new BarBuilder(ids, spec);

  const bars: Bar[] = [];

  // Pickup: bar 0 (ADR-0007), two eighth notes leading into the head.
  bars.push(make({ number: 0 }).note('D5', dur(8)).note('F5', dur(8)).build());

  // The A / A / Bridge / A form. Chords are just enough to read as a tune.
  const chordFor = (bar: number): string => (bar % 4 === 1 ? 'Cmaj7' : bar % 4 === 2 ? 'Am7' : bar % 4 === 3 ? 'Dm7' : 'G7');

  for (let n = 1; n <= 32; n += 1) {
    const spec: Partial<BarSpec> = {};

    // The repeat around the first A section.
    if (n === 1) spec.startBarline = 'repeat-start';
    if (n === 7) {
      // 1st ending: one bar, closed by the repeat that sends the reader back to bar 1.
      spec.ending = ending([1]);
      spec.endBarline = 'repeat-end';
    }
    if (n === 8) spec.ending = ending([2]); // 2nd ending, taken on the second pass.

    // A double bar closes the second A before the bridge; a final bar ends the chart.
    if (n === 16) spec.endBarline = 'double';
    if (n === 32) spec.endBarline = 'final';

    fill(bars, make, n, chordFor(n), spec);
  }

  return makeScore({
    id: 'score-aaba',
    title: 'AABA in C',
    composer: 'sibei-score',
    style: 'Medium swing',
    key: { tonic: 'C', alter: 0, mode: 'major' },
    time: { beats: 4, beatValue: 4 },
    bars,
    sections: FORM.map((name, index) =>
      makeSection({ id: ids.next('section'), startBar: 1 + index * 8, letter: LETTERS[index] ?? null, name }),
    ),
  });
}

/** A single-bar ending bracket (opens and closes on the one bar). */
function ending(numbers: number[]): Ending {
  return { numbers, role: 'start-stop' };
}
