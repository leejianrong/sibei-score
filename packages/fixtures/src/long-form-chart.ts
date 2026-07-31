import type { Bar, IdFactory, Score } from '@sibei/model';
import { createIdFactory, dur, makeScore, makeSection } from '@sibei/model';
import type { BarSpec } from './builder.js';
import { BarBuilder } from './builder.js';

/**
 * The long-form chart: the fixture of record for **pagination**.
 *
 * Everything else in the corpus fits on one page, so until this existed the overflow
 * branch of `paginate()` had never run against a rendered chart and the second page had
 * never been looked at. A chart has to be genuinely long before it spills: at the default
 * staff size a full 32-bar chorus fits an A4 page with room to spare, which is a fact
 * about the product rather than an accident, so the fixture is a 64-bar AABA — a
 * sixteen-bar A, the shape *Cherokee* uses — and it runs to two pages on A4 and three on
 * Letter.
 *
 * What it is built to catch:
 *
 * - the four-bar grid surviving a page break: sixteen systems of four bars each, so a
 *   system that lost or gained a bar at the break would be visible immediately
 * - the second page having **no title block**, its first system starting at the top
 *   margin rather than below a header that is not there
 * - a tie across the page break (bar 32 into bar 33), which is a system break the
 *   pagination pass must leave alone — the two half-ties are planned before pages exist
 * - a section boundary landing exactly on the break, so the bridge's rehearsal mark is
 *   the first ink on page 2
 *
 * The music is diatonic enough to read and awkward enough to be worth engraving: the
 * bridge wanders to the flat keys and brings its accidentals with it, and the melody
 * reaches D6 above the staff and Bb4 below the middle line, so systems differ in height
 * and the pagination arithmetic is not being fed a constant.
 */
export function longFormChart(): Score {
  const ids = createIdFactory();

  const bars = [
    ...aSection(ids, 1, 'turnaround'),
    ...aSection(ids, 17, 'to-bridge'),
    ...bridge(ids, 33),
    ...aSection(ids, 49, 'final'),
  ];

  return makeScore({
    id: 'score-long-form',
    title: 'The Long Way Home',
    composer: 'sibei-score',
    style: 'Medium swing',
    key: { tonic: 'B', alter: -1, mode: 'major' },
    time: { beats: 4, beatValue: 4 },
    bars,
    sections: [
      // AABA, so two sections carry the same letter. That is what a lead sheet prints,
      // and nothing in the model or the grid asks a letter to be unique.
      makeSection({ id: ids.next('section'), startBar: 1, letter: 'A', name: 'A' }),
      makeSection({ id: ids.next('section'), startBar: 17, letter: 'A', name: 'A (repeat)' }),
      makeSection({ id: ids.next('section'), startBar: 33, letter: 'B', name: 'Bridge' }),
      makeSection({ id: ids.next('section'), startBar: 49, letter: 'A', name: 'A (last)' }),
    ],
  });
}

/** One quarter note, in ticks: what a chord symbol's beat position is measured in. */
const BEAT = 480;

/**
 * How an A section gets out of itself. The first two go somewhere; the last one stops.
 */
type ASectionEnding = 'turnaround' | 'to-bridge' | 'final';

/**
 * The A section: sixteen bars, three times over, differing only in the last two.
 *
 * Written once rather than three times because that is what the form says — and because
 * the same fourteen bars typed out three times is three times the places to make a typo
 * that nobody would ever notice in a snapshot.
 */
function aSection(ids: IdFactory, start: number, ending: ASectionEnding): Bar[] {
  const bar = (offset: number, spec: Omit<BarSpec, 'number'> = {}): BarBuilder =>
    new BarBuilder(ids, { number: start + offset, ...spec });

  const common = [
    bar(0).chord(1, 'Bb6', BEAT).note('D5', dur(4)).note('F5', dur(4)).note('Bb5', dur(2)).build(),

    bar(1)
      .chord(1, 'Gm7', BEAT)
      .chord(3, 'C7', BEAT)
      .note('A5', dur(8))
      .note('G5', dur(8))
      .note('F5', dur(4))
      .note('D5', dur(4))
      .note('C5', dur(4))
      .build(),

    bar(2)
      .chord(1, 'Cm7', BEAT)
      .chord(3, 'F7', BEAT)
      .note('Eb5', dur(4))
      .note('G5', dur(4))
      .note('C6', dur(2))
      .build(),

    bar(3)
      .chord(1, 'Bb6', BEAT)
      .chord(3, 'G7', BEAT)
      .note('Bb5', dur(4))
      .note('A5', dur(4))
      .note('G5', dur(2))
      .build(),

    bar(4)
      .chord(1, 'Cm7', BEAT)
      .note('Eb5', dur(2))
      .note('G5', dur(4))
      .note('Bb5', dur(4))
      .build(),

    bar(5)
      .chord(1, 'F7', BEAT)
      .note('A5', dur(8))
      .note('G5', dur(8))
      .note('F5', dur(4))
      .note('Eb5', dur(2))
      .build(),

    bar(6)
      .chord(1, 'Bb6', BEAT)
      .chord(3, 'Bdim7', BEAT)
      .note('D5', dur(4))
      .rest(dur(4))
      .note('F5', dur(2))
      .build(),

    bar(7)
      .chord(1, 'Cm7', BEAT)
      .chord(3, 'F7', BEAT)
      .note('G5', dur(8))
      .note('A5', dur(8))
      .note('Bb5', dur(4))
      .note('C6', dur(2))
      .build(),

    bar(8)
      .chord(1, 'Bb6', BEAT)
      .note('Bb5', dur(2))
      .note('F5', dur(4))
      .note('D5', dur(4))
      .build(),

    bar(9)
      .chord(1, 'Gm7', BEAT)
      .chord(3, 'C7', BEAT)
      .note('C5', dur(8))
      .note('D5', dur(8))
      .note('Eb5', dur(4))
      .note('G5', dur(2))
      .build(),

    bar(10)
      .chord(1, 'Cm7', BEAT)
      .chord(3, 'F7', BEAT)
      .note('F5', dur(4))
      .note('Eb5', dur(4))
      .note('D5', dur(2))
      .build(),

    bar(11)
      .chord(1, 'Bb6', BEAT)
      .chord(3, 'Bb7', BEAT)
      .note('Bb4', dur(4))
      .note('D5', dur(4))
      .note('F5', dur(2))
      .build(),

    bar(12).chord(1, 'Ebmaj7', BEAT).note('Bb5', dur(1)).build(),

    // Gb against a two-flat key signature: an accidental that has to be drawn, and
    // cancelled by the F natural that follows it in the same bar.
    bar(13).chord(1, 'Ebm6', BEAT).note('Gb5', dur(2)).note('F5', dur(2)).build(),
  ];

  return [...common, ...aSectionEnding(bar, ending)];
}

/** The last two bars of an A section, which is the only part that varies. */
function aSectionEnding(
  bar: (offset: number, spec?: Omit<BarSpec, 'number'>) => BarBuilder,
  ending: ASectionEnding,
): Bar[] {
  if (ending === 'final') {
    return [
      bar(14)
        .chord(1, 'Cm7', BEAT)
        .chord(3, 'F7', BEAT)
        .note('F5', dur(4))
        .note('D5', dur(4))
        .note('C5', dur(4))
        .note('D5', dur(4))
        .build(),
      bar(15, { endBarline: 'final' }).chord(1, 'Bb6', BEAT).note('Bb4', dur(1)).build(),
    ];
  }

  const turnaround = bar(14)
    .chord(1, 'Bb6', BEAT)
    .chord(3, 'G7', BEAT)
    .note('F5', dur(4))
    .note('D5', dur(4))
    .note('Bb4', dur(2))
    .build();

  if (ending === 'to-bridge') {
    // Ties into the bridge, which is where the page break falls: the tie has to survive
    // being cut in half by a page as cleanly as it does by a system.
    return [
      turnaround,
      bar(15)
        .chord(1, 'Cm7', BEAT)
        .chord(3, 'F7', BEAT)
        .note('C5', dur(4))
        .note('Eb5', dur(4))
        .note('F5', dur(2), 'start')
        .build(),
    ];
  }

  return [
    turnaround,
    bar(15)
      .chord(1, 'Cm7', BEAT)
      .chord(3, 'F7', BEAT)
      .note('C5', dur(8))
      .note('D5', dur(8))
      .note('Eb5', dur(4))
      .note('F5', dur(2))
      .build(),
  ];
}

/**
 * The bridge: sixteen bars away to the subdominant and the flat keys, and back. It is
 * where the accidentals live, and its first bar closes the tie that began on page 1.
 */
function bridge(ids: IdFactory, start: number): Bar[] {
  const bar = (offset: number): BarBuilder => new BarBuilder(ids, { number: start + offset });

  return [
    bar(0)
      .chord(1, 'Fm7', BEAT)
      .chord(3, 'Bb7', BEAT)
      .note('F5', dur(2), 'stop')
      .note('G5', dur(4))
      .note('Ab5', dur(4))
      .build(),

    bar(1).chord(1, 'Ebmaj7', BEAT).note('G5', dur(2)).note('Bb5', dur(2)).build(),

    bar(2)
      .chord(1, 'Fm7', BEAT)
      .chord(3, 'Bb7', BEAT)
      .note('C6', dur(4))
      .note('Bb5', dur(4))
      .note('Ab5', dur(2))
      .build(),

    bar(3).chord(1, 'Ebmaj7', BEAT).note('G5', dur(1)).build(),

    bar(4).chord(1, 'Abmaj7', BEAT).note('C6', dur(2)).note('Bb5', dur(2)).build(),

    bar(5)
      .chord(1, 'Abm7', BEAT)
      .chord(3, 'Db7', BEAT)
      .note('Ab5', dur(4))
      .note('Gb5', dur(4))
      .note('F5', dur(2))
      .build(),

    bar(6)
      .chord(1, 'Ebmaj7', BEAT)
      .note('G5', dur(4))
      .note('Eb5', dur(4))
      .note('Bb4', dur(2))
      .build(),

    bar(7)
      .chord(1, 'Cm7', BEAT)
      .chord(3, 'F7', BEAT)
      .note('C5', dur(4))
      .note('Eb5', dur(4))
      .note('G5', dur(2))
      .build(),

    // The melodic peak, D6, two ledger lines up.
    bar(8).chord(1, 'Ebmaj7', BEAT).note('D6', dur(2)).note('Bb5', dur(2)).build(),

    bar(9)
      .chord(1, 'Ebm7', BEAT)
      .chord(3, 'Ab7', BEAT)
      .note('Bb5', dur(4))
      .note('Gb5', dur(4))
      .note('F5', dur(2))
      .build(),

    bar(10).chord(1, 'Dbmaj7', BEAT).note('F5', dur(2)).note('Ab5', dur(2)).build(),

    bar(11)
      .chord(1, 'C7alt', BEAT)
      .note('Eb5', dur(4))
      .note('Db5', dur(4))
      .note('C5', dur(2))
      .build(),

    bar(12)
      .chord(1, 'Fm7', BEAT)
      .chord(3, 'Bb7', BEAT)
      .note('Ab5', dur(8))
      .note('G5', dur(8))
      .note('F5', dur(4))
      .note('D5', dur(2))
      .build(),

    bar(13).chord(1, 'Ebmaj7', BEAT).note('G5', dur(2)).note('Eb5', dur(2)).build(),

    bar(14)
      .chord(1, 'Cm7', BEAT)
      .chord(3, 'F7', BEAT)
      .note('Eb5', dur(8))
      .note('F5', dur(8))
      .note('G5', dur(4))
      .note('A5', dur(2))
      .build(),

    bar(15)
      .chord(1, 'F7', BEAT)
      .note('Bb5', dur(4))
      .note('A5', dur(4))
      .note('G5', dur(2))
      .build(),
  ];
}
