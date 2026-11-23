import type { Score } from '@sibei/model';
import { createIdFactory, dur, makeStaffedScore, voiceOfView } from '@sibei/model';
import type { BarView, VoiceInit } from '@sibei/model';
import { BarBuilder } from './builder.js';

/**
 * Instrument names on the system (SIB2-286): four parts (a trumpet, a grand staff, a bass, a kit), each with a full
 * name and a short one, so the first system prints the full names and the later ones the abbreviations. `layout: 'score'`
 * breaks by width, so a dozen bars run to several systems.
 */
export function instrumentNamesChart(): Score {
  const ids = createIdFactory();
  const make = (number: number): BarBuilder => new BarBuilder(ids, { number });
  const q = dur(4);
  const e = dur(8);
  const count = 12;
  const lines = (write: (n: number) => BarBuilder): VoiceInit[] =>
    Array.from({ length: count }, (_, index) => voiceOfView(write(index + 1).build()));
  const lead = (n: number): BarBuilder => make(n).chord(1, ['Cmaj7', 'A7', 'Dm7', 'G7'][(n - 1) % 4]!, 480).note('E5', q).note('G5', q).note('E5', q).note('D5', q);
  const rh = (n: number): BarBuilder => make(n).note('G4', q).note('C5', q).note('E5', e).note('D5', e).note('C5', q);
  const lh = (n: number): BarBuilder => make(n).note('C3', dur(2)).note('G2', dur(2));
  const bass = (n: number): BarBuilder => make(n).note('C2', q).note('G2', q).note('C3', q).note('G2', q);
  const kit = (n: number): BarBuilder => {
    const b = make(n);
    for (let i = 0; i < 8; i += 1) b.note('F5', e);
    return b;
  };
  const grid: BarView[] = Array.from({ length: count }, (_, index) => lead(index + 1).build());
  const score = makeStaffedScore({
    id: 'instrument-names',
    title: 'Instrument Names',
    composer: 'fixture',
    bars: grid,
    parts: [
      { name: 'Trumpet in Bb', shortName: 'Tpt.', instrument: 56, transposition: -2, staves: [{ clef: 'treble', bars: lines(lead) }] },
      {
        name: 'Piano',
        shortName: 'Pno.',
        instrument: 0,
        staves: [
          { clef: 'treble', bars: lines(rh) },
          { clef: 'bass', bars: lines(lh) },
        ],
      },
      { name: 'Electric Bass', shortName: 'Bass', instrument: 33, staves: [{ clef: 'bass', bars: lines(bass) }] },
      { name: 'Drum Kit', shortName: 'Dr.', staves: [{ type: 'percussion', bars: lines(kit) }] },
    ],
  });
  return { ...score, meta: { ...score.meta, layout: 'score', showInstrumentNames: true } };
}
