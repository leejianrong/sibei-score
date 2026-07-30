import type { Score, TimeSignature } from '@sibei/model';
import { createIdFactory, dur, makeScore, makeSection } from '@sibei/model';
import { BarBuilder } from './builder.js';

/** Small fixtures for the grid, pagination and metric-validity tests. */

export interface BarCountOptions {
  /** Bar numbers a section begins on. Bar 1 is implicit and needs no entry. */
  sectionStarts?: number[];
  withPickup?: boolean;
  time?: TimeSignature;
}

/**
 * `barCount` full bars of four quarter notes each, optionally with sections and a
 * pickup. Exists so a grid test can say "eleven bars" and mean it.
 */
export function barCountChart(barCount: number, options: BarCountOptions = {}): Score {
  const ids = createIdFactory();
  const time = options.time ?? { beats: 4, beatValue: 4 };
  const bars = [];

  if (options.withPickup === true) {
    bars.push(new BarBuilder(ids, { number: 0 }).note('C5', dur(4)).build());
  }

  for (let number = 1; number <= barCount; number += 1) {
    const builder = new BarBuilder(ids, { number });
    for (let beat = 0; beat < time.beats; beat += 1) builder.note('C5', dur(time.beatValue));
    bars.push(builder.build());
  }

  const sections = (options.sectionStarts ?? []).map((startBar, index) =>
    makeSection({
      id: ids.next('section'),
      startBar,
      letter: String.fromCharCode(65 + index),
    }),
  );

  return makeScore({ id: `score-${barCount}-bars`, title: `${barCount} bars`, time, bars, sections });
}

/**
 * A chart that emits every kind in the layout contract, so "the draw adapter handles
 * all of them" can be asserted against something real rather than against a list.
 * Eight bars, so a second system starts at a bar number that prints.
 */
export function everyGlyphChart(): Score {
  const ids = createIdFactory();
  const beat = 480;

  const bars = [
    new BarBuilder(ids, { number: 0 }).note('G4', dur(4)).build(),

    new BarBuilder(ids, { number: 1, startBarline: 'repeat-start' })
      .chord(1, 'Cmaj7', beat)
      .note('C5', dur(4))
      .rest(dur(4))
      .note('E5', dur(2), 'start')
      .build(),

    new BarBuilder(ids, { number: 2 })
      .chord(1, 'Am7', beat)
      .annotation(3, 'solo break', beat)
      .note('E5', dur(2), 'stop')
      .tuplet(3, 2, (t) => {
        t.note('F5', dur(4)).note('G5', dur(4)).note('A5', dur(4));
      })
      .build(),

    new BarBuilder(ids, { number: 3, ending: { numbers: [1], role: 'start-stop' } })
      .chord(1, 'Dm7', beat)
      .note('F5', dur(2, 1))
      .note('E5', dur(4))
      .build(),

    new BarBuilder(ids, { number: 4, endBarline: 'repeat-end' })
      .chord(1, 'G7', beat)
      .note('D5', dur(1))
      .build(),

    new BarBuilder(ids, { number: 5 }).chord(1, 'Cmaj7', beat).note('C5', dur(1)).build(),
    new BarBuilder(ids, { number: 6 }).chord(1, 'F#m7b5', beat).note('F#5', dur(1)).build(),
    new BarBuilder(ids, { number: 7 }).chord(1, 'C7alt', beat).note('E5', dur(1)).build(),
    new BarBuilder(ids, { number: 8, endBarline: 'final' })
      .chord(1, 'Cmaj7', beat)
      .note('C5', dur(1))
      .build(),
  ];

  return makeScore({
    id: 'score-every-glyph',
    title: 'Every Glyph',
    composer: 'sibei-score',
    style: 'Ballad',
    bars,
    sections: [
      makeSection({ id: ids.next('section'), startBar: 1, letter: 'A' }),
      makeSection({ id: ids.next('section'), startBar: 5, letter: 'B' }),
    ],
  });
}

/**
 * Beaming, isolated. Bar 1 is nothing but beamable groups; bar 2 holds a single
 * unbeamable eighth as the control.
 *
 * Every pitch sits between the bottom and top staff lines (E4 to F5) and there are no
 * accidentals and no dots. That is deliberate: it leaves a note's group in the rendered
 * SVG containing nothing but its notehead and stem, so a bare path in that group can
 * only be a flag. Add a note above the staff and its ledger lines land in the same
 * place, and the signal stops meaning anything.
 */
export function beamingChart(): Score {
  const ids = createIdFactory();
  const bars = [
    new BarBuilder(ids, { number: 1 })
      .note('C5', dur(8))
      .note('D5', dur(8))
      .note('E5', dur(16))
      .note('F5', dur(16))
      .note('E5', dur(16))
      .note('D5', dur(16))
      .note('C5', dur(8))
      .note('B4', dur(8))
      .note('A4', dur(8))
      .note('G4', dur(8))
      .build(),

    // One eighth alone on its beat has nothing to beam to, so it keeps its flag.
    new BarBuilder(ids, { number: 2 })
      .note('C5', dur(8))
      .rest(dur(8))
      .note('D5', dur(4))
      .note('E5', dur(4))
      .note('F5', dur(4))
      .build(),
  ];

  return makeScore({ id: 'score-beaming', title: 'Beaming', bars });
}

/**
 * Three bars: one short, one exact, one overfull. Metrically invalid bars are stored
 * and flagged, never rejected (ADR-0013), so a fixture that contains them is the
 * point rather than a problem.
 */
export function invalidBarChart(): Score {
  const ids = createIdFactory();
  const bars = [
    new BarBuilder(ids, { number: 1 }).note('C5', dur(4)).note('D5', dur(4)).build(),
    new BarBuilder(ids, { number: 2 })
      .note('E5', dur(4))
      .note('F5', dur(4))
      .note('G5', dur(4))
      .note('A5', dur(4))
      .build(),
    new BarBuilder(ids, { number: 3 })
      .note('B5', dur(2))
      .note('C6', dur(2))
      .note('D6', dur(4))
      .build(),
  ];

  return makeScore({ id: 'score-invalid-bars', title: 'Invalid bars', bars });
}
