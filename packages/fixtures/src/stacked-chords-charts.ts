import type { BarView, IdFactory, Score, StackedNote, TieRole } from '@sibei/model';
import { createIdFactory, dur, makeScore, makeStaffedScore, parsePitch, voiceOfView } from '@sibei/model';
import type { VoiceInit } from '@sibei/model';
import { BarBuilder } from './builder.js';

/**
 * The stacked-chord fixtures (SIB2-243, ADR-0041 "As built: stacked chords"). Invented music, nothing from a real page.
 * Each bar puts a different pressure on the chord engraving: a plain triad, seconds (the head that moves across the
 * stem), several accidentals (the columns), ledger lines above and below, dots, beamed eighth chords and ties.
 */

const q = dur(4);
const h = dur(2);
const e = dur(8);

/** The carrying note at `n` (1-based) of the bar takes the other `pitches` as a stack, each with an optional tie. */
function stacked(ids: IdFactory, view: BarView, n: number, ...pitches: (string | [string, TieRole])[]): BarView {
  const item = view.items[n - 1];
  if (item === undefined || item.kind !== 'note') throw new Error(`no note at n${n}`);
  item.stack = pitches.map((spec): StackedNote => {
    const [pitch, tie] = typeof spec === 'string' ? [spec, 'none' as TieRole] : spec;
    return { id: ids.next('note'), pitch: parsePitch(pitch), accidental: 'auto', tie, spellingPinned: false };
  });
  return view;
}

/**
 * A single staff: a triad, seconds, accidentals, ledger lines, dots, beamed eighth chords, and ties across a barline.
 * - bar 1: three quarter triads and a half-step cluster, stems up
 * - bar 2: seconds: a pair at the bottom, a pair high with the stem down, a lone second, a four-note cluster
 * - bar 3: a flat chord and a sharp chord, with accidentals that must stack into columns
 * - bar 4: chords far above and far below the staff (ledger lines for several heads), a dotted half, a quarter rest
 * - bar 5: beamed eighth chords, one beamed pair with a second
 * - bar 6: a chord whose C and G are tied into bar 7's chord, which also has a dotted half
 */
export function stackedChordsChart(): Score {
  const ids = createIdFactory();
  const make = (number: number, end?: 'final'): BarBuilder =>
    new BarBuilder(ids, end === undefined ? { number } : { number, endBarline: end });
  const bars: BarView[] = [
    stacked(ids, make(1).chord(1, 'C', 480).note('C4', q).note('D4', q).note('E4', q).note('F4', q).build(), 1, 'E4', 'G4'),
    make(2).chord(1, 'Dm7', 480).note('C4', q).note('E5', q).note('B4', q).note('G4', q).build(),
    make(3).chord(1, 'Eb', 480).note('Eb4', h).note('F#4', h).build(),
    make(4).chord(1, 'C', 480).note('A5', q).note('G3', dur(2, 1)).build(),
    make(5).chord(1, 'F', 480).note('C4', e).note('C4', e).note('D4', e).note('D4', e).note('E4', h).build(),
    make(6).chord(1, 'G', 480).note('C4', q, 'start').note('B3', q).note('A3', h).build(),
    make(7, 'final').chord(1, 'C', 480).note('C4', dur(2, 1)).rest(q).build(),
  ];
  const at = (bar: number, n: number, ...pitches: (string | [string, TieRole])[]): void => {
    stacked(ids, bars[bar - 1]!, n, ...pitches);
  };
  at(1, 2, 'F4', 'A4');
  at(1, 3, 'G4', 'B4');
  at(1, 4, 'F#4', 'G4');
  at(2, 1, 'D4', 'G4');
  at(2, 2, 'F5', 'A5');
  at(2, 3, 'C5');
  at(2, 4, 'A4', 'B4', 'C5');
  at(3, 1, 'G4', 'Bb4', 'Db5');
  at(3, 2, 'A#4', 'C#5', 'E5');
  at(4, 1, 'C6', 'E6');
  at(4, 2, 'D3', 'B2');
  at(5, 1, 'E4', 'G4');
  at(5, 2, 'E4', 'G4');
  at(5, 3, 'F4', 'A4');
  at(5, 4, 'E4', 'F4');
  at(5, 5, 'G4', 'C5');
  at(6, 1, ['E4', 'none'], ['G4', 'start']);
  at(6, 2, 'D4', 'G4');
  at(6, 3, 'E4', 'C4');
  at(7, 1, ['E4', 'none'], ['G4', 'stop']);
  const first = bars[6]!.items[0];
  if (first?.kind === 'note') first.tie = 'stop';
  return makeScore({ id: 'stacked-chords', title: 'Stacked Chords', composer: 'Proof chart', bars });
}

/**
 * A piano's grand staff with real chords in both hands, and a second voice on the treble staff: right-hand triads over a
 * left hand of octaves and fifths, a treble melody voice above held chords in voice 2, and a bass chord low enough to
 * need ledger lines.
 */
export function pianoChordsChart(): Score {
  const ids = createIdFactory();
  const make = (number: number): BarBuilder => new BarBuilder(ids, { number });
  const count = 4;
  const view = (staff: 'rh' | 'rh2' | 'lh', n: number): BarBuilder | null => {
    const b = make(n);
    if (staff === 'rh') {
      return n % 2 === 1
        ? b.note('G5', q).note('E5', q).note('D5', q).note('C5', q)
        : b.note('E5', h).note('C5', h);
    }
    if (staff === 'rh2') return n % 2 === 1 ? b.note('C4', h).note('E4', h) : null;
    return n % 2 === 1 ? b.note('C3', h).note('G2', h) : b.note('C3', dur(1));
  };
  const stackAll = (staff: 'rh' | 'rh2' | 'lh', n: number, builder: BarBuilder): BarView => {
    const v = builder.build();
    if (staff === 'rh2') {
      stacked(ids, v, 1, 'E4', 'G4');
      stacked(ids, v, 2, 'F4', 'A4');
    } else if (staff === 'lh') {
      if (n % 2 === 1) {
        stacked(ids, v, 1, 'G3', 'E3');
        stacked(ids, v, 2, 'D3', 'B2');
      } else {
        stacked(ids, v, 1, 'G2', 'E2', 'C2');
      }
    }
    return v;
  };
  const staffBars = (staff: 'rh' | 'rh2' | 'lh'): (VoiceInit | VoiceInit[])[] =>
    Array.from({ length: count }, (_, i) => {
      const n = i + 1;
      const builder = view(staff, n);
      if (staff === 'rh') {
        const melody = voiceOfView(stackAll('rh', n, builder!));
        const second = view('rh2', n);
        return second === null ? melody : [melody, voiceOfView(stackAll('rh2', n, second))];
      }
      return voiceOfView(stackAll(staff, n, builder!));
    });
  return makeStaffedScore({
    id: 'piano-chords',
    title: 'Piano Chords',
    composer: 'Proof chart',
    bars: Array.from({ length: count }, (_, i) => make(i + 1).chord(1, i % 2 === 0 ? 'C' : 'Am7', 480).build()),
    parts: [
      {
        name: 'Piano',
        instrument: 0,
        staves: [
          { clef: 'treble', bars: staffBars('rh') },
          { clef: 'bass', bars: staffBars('lh') },
        ],
      },
    ],
  });
}
