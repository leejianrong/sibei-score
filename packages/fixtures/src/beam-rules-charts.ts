import type { Score, TimeSignature } from '@sibei/model';
import { createIdFactory, dur, makeScore } from '@sibei/model';
import { BarBuilder } from './builder.js';

/**
 * Beaming rules, one synthetic chart per time signature (SIB2-154). Each bar is a single rule, in the
 * order the PR body lists them, so a proof image reads as a checklist. Notes only: no chords, so the
 * only ink in a bar is the thing being judged.
 */

type Ids = ReturnType<typeof createIdFactory>;
type Build = (ids: Ids, number: number) => BarBuilder;

function chart(id: string, title: string, time: TimeSignature, bars: readonly Build[]): Score {
  const ids = createIdFactory();
  return makeScore({
    id,
    title,
    time,
    bars: bars.map((build, index) => build(ids, index + 1).build()),
  });
}

const bar = (ids: Ids, number: number): BarBuilder => new BarBuilder(ids, { number });

/** 4/4, the jazz default. */
export function beamRulesChart(): Score {
  const e = dur(8);
  const s = dur(16);
  return chart('score-beam-rules', 'Beam rules 4/4', { beats: 4, beatValue: 4 }, [
    // Eighths only: a half bar is one group (4 eighths), never across the middle of the bar.
    (i, n) => bar(i, n).note('C5', e).note('D5', e).note('E5', e).note('F5', e).note('G5', e).note('F5', e).note('E5', e).note('D5', e),
    // A sixteenth in the half bar drops it back to beat groups.
    (i, n) => bar(i, n).note('C5', e).note('D5', s).note('E5', s).note('F5', e).note('E5', e).note('D5', e).note('C5', e).note('B4', e).note('A4', e),
    // Sixteenths: four to a beat, two beams.
    (i, n) => bar(i, n).note('E5', s).note('F5', s).note('G5', s).note('A5', s).note('G5', s).note('F5', s).note('E5', s).note('D5', s).note('C5', dur(2)),
    // A rest breaks a group (jazz style): beams never run over it.
    (i, n) => bar(i, n).note('C5', e).rest(e).note('E5', e).note('F5', e).note('G5', e).note('A5', e).rest(e).note('E5', e),
    // Dotted rhythms: broken (stubbed) secondary beams, pointing at the dotted note.
    (i, n) => bar(i, n).note('G5', dur(8, 1)).note('F5', s).note('E5', s).note('D5', dur(8, 1)).note('C5', dur(8, 1)).note('D5', s).note('E5', e).note('F5', e),
    // Triplets: a beat of eighth triplets beams as one group, the quarter triplet takes a bracket only.
    (i, n) => bar(i, n)
      .tuplet(3, 2, (t) => { t.note('C5', e).note('D5', e).note('E5', e); })
      .tuplet(3, 2, (t) => { t.note('F5', e).note('E5', e).note('D5', e); })
      .tuplet(3, 2, (t) => { t.note('E5', dur(4)).note('F5', dur(4)).note('G5', dur(4)); }),
    // Stem direction by the furthest note from the middle line; slope limited on a wide leap.
    (i, n) => bar(i, n).note('E4', e).note('A5', e).note('B5', e).note('C6', e).note('C4', e).note('G4', e).note('F5', e).note('A4', e),
    // Syncopation: the quarter between two eighths breaks the group on both sides.
    (i, n) => bar(i, n).note('C5', e).note('D5', dur(4)).note('E5', e).note('F5', dur(2)),
  ]);
}

/** 6/8: two dotted-quarter groups. */
export function beamRules68Chart(): Score {
  const e = dur(8);
  const s = dur(16);
  return chart('score-beam-rules-68', 'Beam rules 6/8', { beats: 6, beatValue: 8 }, [
    (i, n) => bar(i, n).note('C5', e).note('D5', e).note('E5', e).note('F5', e).note('E5', e).note('D5', e),
    (i, n) => bar(i, n).note('C5', dur(4)).note('D5', e).note('E5', dur(4)).note('F5', e),
    (i, n) => bar(i, n).note('G5', e).note('F5', s).note('E5', s).note('D5', e).note('C5', e).rest(e).note('E5', e),
    // Six sixteenths to a group: the second beam breaks at the eighth, three and three.
    (i, n) => bar(i, n).note('C5', s).note('D5', s).note('E5', s).note('F5', s).note('G5', s).note('A5', s).note('G5', s).note('F5', s).note('E5', s).note('D5', s).note('C5', s).note('B4', s),
  ]);
}

/** 3/4: a group per beat. */
export function beamRules34Chart(): Score {
  const e = dur(8);
  return chart('score-beam-rules-34', 'Beam rules 3/4', { beats: 3, beatValue: 4 }, [
    (i, n) => bar(i, n).note('C5', e).note('D5', e).note('E5', e).note('F5', e).note('G5', e).note('F5', e),
    (i, n) => bar(i, n).note('C5', dur(4)).note('D5', e).note('E5', e).note('F5', dur(4)),
  ]);
}

/** Cut time (2/2): eighths group by the half note. */
export function beamRulesCutChart(): Score {
  const e = dur(8);
  return chart('score-beam-rules-cut', 'Beam rules cut time', { beats: 2, beatValue: 2 }, [
    (i, n) => bar(i, n).note('C5', e).note('D5', e).note('E5', e).note('F5', e).note('G5', e).note('F5', e).note('E5', e).note('D5', e),
    (i, n) => bar(i, n).note('C5', dur(4)).note('D5', e).note('E5', e).note('F5', dur(2)),
    // Eight sixteenths in a half note: the second beam breaks at each quarter.
    (i, n) => bar(i, n).note('C5', dur(16)).note('D5', dur(16)).note('E5', dur(16)).note('F5', dur(16)).note('G5', dur(16)).note('F5', dur(16)).note('E5', dur(16)).note('D5', dur(16)).note('C5', dur(2)),
  ]);
}
