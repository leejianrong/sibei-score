import type { Score } from '@sibei/model';
import { createIdFactory, dur, makeScore, makeSection } from '@sibei/model';
import { BarBuilder } from './builder.js';

/**
 * The nasty test chart: the fixture of record for the ADR-0014 spike gate, and the
 * regression fixture thereafter.
 *
 * It is built to be awkward on purpose. Every feature listed below is here because
 * getting it wrong is visible from a music stand:
 *
 * - a pickup bar, which must sit before bar 1 without taking a four-bar slot
 * - an 11-bar A section, so the grid has to break 4 / 4 / 3 rather than 4 / 4 / 4
 * - a tie across a barline (bar 4 into 5) and one across a **system** break (8 into 9)
 * - an eighth-note triplet (bar 3) and a quarter-note triplet (bar 10)
 * - a double barline closing the A section, and a repeat pair around the B section
 * - accidentals that fight the key signature: A natural, E natural, B natural then Bb
 * - ledger lines above (C6) and below (E3) the staff
 * - dense chord symbols, two to a bar, including `C7alt`, `F#m7b5`, `Bb13#11`,
 *   `Ab/Eb` and `N.C.`
 */
export function nastyChart(): Score {
  const ids = createIdFactory();
  const beat = 480;

  const bar = (number: number, options: Parameters<typeof makeBarSpec>[1] = {}): BarBuilder =>
    new BarBuilder(ids, makeBarSpec(number, options));

  const bars = [
    // Pickup. Bar 0 by definition (ADR-0007).
    bar(0).note('Bb4', dur(8)).note('C5', dur(8)).build(),

    bar(1)
      .chord(1, 'Ebmaj7', beat)
      .note('C5', dur(4))
      .note('Eb5', dur(4))
      .note('G5', dur(2))
      .build(),

    bar(2)
      .chord(1, 'Ebm7', beat)
      .chord(3, 'Ab7', beat)
      .note('G5', dur(8))
      .note('F5', dur(8))
      .note('Eb5', dur(4))
      .note('D5', dur(4))
      .note('C5', dur(4))
      .build(),

    bar(3)
      .chord(1, 'Bb13#11', beat)
      .tuplet(3, 2, (t) => {
        t.note('C5', dur(8)).note('D5', dur(8)).note('Eb5', dur(8));
      })
      .note('F5', dur(4))
      .note('G5', dur(4))
      .note('Ab5', dur(4))
      .build(),

    // Ties into bar 5.
    bar(4)
      .chord(1, 'Cm7', beat)
      .chord(3, 'F7', beat)
      .note('Eb5', dur(2))
      .note('F5', dur(4))
      .note('G5', dur(4), 'start')
      .build(),

    bar(5)
      .chord(1, 'Bbmaj7', beat)
      .note('G5', dur(4), 'stop')
      .rest(dur(4))
      .note('A5', dur(2))
      .build(),

    bar(6)
      .chord(1, 'Eb6', beat)
      .chord(3, 'C7alt', beat)
      .note('Bb5', dur(16))
      .note('A5', dur(16))
      .note('G5', dur(16))
      .note('F5', dur(16))
      .note('Eb5', dur(4))
      .note('D5', dur(2))
      .build(),

    bar(7).chord(1, 'Fm7', beat).note('C6', dur(1)).build(),

    // Ties into bar 9, which is the first bar of the next system.
    bar(8)
      .chord(1, 'Bb7', beat)
      .note('E3', dur(4))
      .note('G3', dur(4))
      .note('Bb4', dur(2), 'start')
      .build(),

    bar(9)
      .chord(1, 'Ebmaj7', beat)
      .note('Bb4', dur(2), 'stop')
      .note('Ab4', dur(2))
      .build(),

    bar(10)
      .chord(1, 'F#m7b5', beat)
      .chord(3, 'B7', beat)
      .tuplet(3, 2, (t) => {
        t.note('C5', dur(4)).note('D5', dur(4)).note('Eb5', dur(4));
      })
      .note('F5', dur(2))
      .build(),

    // Closes the A section.
    bar(11, { endBarline: 'double' })
      .chord(1, 'Fm7', beat)
      .chord(3, 'Bb7', beat)
      .note('Eb5', dur(4))
      .rest(dur(8))
      .note('F5', dur(8))
      .note('G5', dur(2))
      .build(),

    bar(12, { startBarline: 'repeat-start' })
      .chord(1, 'F#m7b5', beat)
      .note('F#5', dur(4))
      .note('A5', dur(4))
      .note('C6', dur(2))
      .build(),

    // Ties into bar 14, which is on the same system: a tie across a plain barline,
    // as distinct from the two above that cross a system break.
    bar(13)
      .chord(1, 'B7', beat)
      .chord(3, 'Bbm7', beat)
      .note('C6', dur(8))
      .note('Bb5', dur(8))
      .note('Ab5', dur(4))
      .note('G5', dur(2), 'start')
      .build(),

    bar(14)
      .chord(1, 'Eb7', beat)
      .note('G5', dur(2, 1), 'stop')
      .note('E5', dur(4))
      .build(),

    bar(15).chord(1, 'Abmaj7', beat).note('D5', dur(1)).build(),

    bar(16)
      .chord(1, 'C7alt', beat)
      .chord(3, 'N.C.', beat)
      .note('C5', dur(4))
      .note('B4', dur(4))
      .note('Bb4', dur(4))
      .note('A4', dur(4))
      .build(),

    bar(17)
      .chord(1, 'Fm7', beat)
      .chord(3, 'Bb7alt', beat)
      .note('Ab4', dur(2))
      .note('G4', dur(2))
      .build(),

    bar(18)
      .chord(1, 'Ebmaj7', beat)
      .chord(3, 'Ab/Eb', beat)
      .note('F4', dur(4))
      .note('G4', dur(8))
      .note('Ab4', dur(8))
      .note('Bb4', dur(2))
      .build(),

    bar(19, { endBarline: 'repeat-end' })
      .chord(1, 'Ebmaj7', beat)
      .note('Eb4', dur(1))
      .build(),
  ];

  return makeScore({
    id: 'score-nasty',
    title: 'Nasty Little Number',
    composer: 'sibei-score',
    style: 'Medium up swing',
    key: { tonic: 'E', alter: -1, mode: 'major' },
    time: { beats: 4, beatValue: 4 },
    bars,
    sections: [
      makeSection({ id: ids.next('section'), startBar: 1, letter: 'A', name: 'A' }),
      makeSection({ id: ids.next('section'), startBar: 12, letter: 'B', name: 'Bridge' }),
    ],
  });
}

function makeBarSpec(
  number: number,
  options: { startBarline?: 'none' | 'repeat-start'; endBarline?: 'single' | 'double' | 'final' | 'repeat-end' },
): { number: number; startBarline?: 'none' | 'repeat-start'; endBarline?: 'single' | 'double' | 'final' | 'repeat-end' } {
  return { number, ...options };
}
