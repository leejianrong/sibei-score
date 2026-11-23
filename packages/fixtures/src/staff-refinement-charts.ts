import type { Score } from '@sibei/model';
import { createIdFactory, dur, makeStaffedScore, voiceOfView } from '@sibei/model';
import { BarBuilder } from './builder.js';

/**
 * Fixtures for SIB2-233 and SIB2-241, the multi-staff refinements of ADR-0041's slice 4: an ottava line on a staff that
 * is not the top one, and a clef change at a bar. Each is chosen so the proof shows the one thing.
 */

const BEAT = 480;
const q = dur(4);
const h = dur(2);

/**
 * A grand staff with an 8va over the right hand's high notes in bars 1-2 and an 8vb under the left hand's low ones in
 * bars 3-4, so each line is drawn on the staff it belongs to, with room reserved there and not above the top staff.
 */
export function ottavaStavesChart(): Score {
  const ids = createIdFactory();
  const make = (number: number): BarBuilder => new BarBuilder(ids, { number });
  const count = 4;
  const rh = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const b = make(n).chord(1, ['C', 'F', 'G7', 'C'][i]!, BEAT);
    return (n <= 2 ? b.note('C6', q).note('E6', q).note('G6', q).note('E6', q) : b.note('E5', h).note('C5', h)).build();
  });
  const lh = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const b = make(n);
    return (n <= 2 ? b.note('C3', h).note('G2', h) : b.note('C2', q).note('G1', q).note('C2', q).note('E2', q)).build();
  });
  const note = (views: typeof rh, bar: number, n: number): string => {
    const item = views[bar - 1]?.items.filter((x) => x.kind === 'note')[n - 1];
    if (item === undefined) throw new Error(`no note bar${bar}.n${n}`);
    return item.id;
  };
  const score = makeStaffedScore({
    id: 'ottava-staves',
    title: 'Ottava on Each Staff',
    composer: 'fixture',
    bars: rh,
    parts: [
      {
        name: 'Piano',
        instrument: 0,
        staves: [
          { clef: 'treble', bars: rh.map((view) => voiceOfView(view)) },
          { clef: 'bass', bars: lh.map((view) => voiceOfView(view)) },
        ],
      },
    ],
  });
  score.spanners = [
    { id: 'ottava-rh', kind: 'ottava', startId: note(rh, 1, 1), endId: note(rh, 2, 4), octaveShift: 'up' },
    { id: 'ottava-lh', kind: 'ottava', startId: note(lh, 3, 1), endId: note(lh, 4, 4), octaveShift: 'down' },
  ];
  return score;
}

/**
 * Fermatas on a grand staff: bar 1 a bass note below the staff (the fermata hangs under it, not across the staff on the
 * far side), bar 2 a stem-down voice in the right hand (under, its own side) with the upper voice's above, bar 3 a note
 * inside the staff (above it, as ever) and bar 4 a high treble note (above its ledger lines).
 */
export function fermatasStavesChart(): Score {
  const ids = createIdFactory();
  const make = (number: number): BarBuilder => new BarBuilder(ids, { number });
  const count = 4;
  const w = dur(1);
  const upper = [
    make(1).chord(1, 'C', BEAT).note('E5', w),
    make(2).chord(1, 'F', BEAT).note('A5', w),
    make(3).chord(1, 'G7', BEAT).note('D5', w),
    make(4).chord(1, 'C', BEAT).note('C7', w),
  ].map((b) => b.build());
  const lower = [make(1).rest(w), make(2).note('C5', w), make(3).rest(w), make(4).rest(w)].map((b) => b.build());
  const bass = [make(1).note('E2', w), make(2).note('F2', w), make(3).note('B2', w), make(4).note('C2', w)].map((b) => b.build());
  const mark = (view: (typeof upper)[number]): void => {
    const item = view.items.find((x) => x.kind === 'note');
    if (item !== undefined) item.fermata = true;
  };
  mark(upper[1]!);
  mark(upper[3]!);
  mark(lower[1]!);
  mark(bass[0]!);
  mark(bass[2]!);
  return makeStaffedScore({
    id: 'fermatas-staves',
    title: 'Fermatas on a Grand Staff',
    composer: 'fixture',
    bars: upper,
    parts: [
      {
        name: 'Piano',
        instrument: 0,
        staves: [
          { clef: 'treble', bars: upper.map((view, i) => (i === 1 ? [voiceOfView(view), voiceOfView(lower[1]!)] : voiceOfView(view))) },
          { clef: 'bass', bars: bass.map((view) => voiceOfView(view)) },
        ],
      },
    ],
  });
}

/**
 * A clef change at a bar (SIB2-241): a lower staff that opens in bass, changes to treble at bar 3 (a small clef in that
 * bar's lead-in, mid-system), carries on in treble over the next system break (which therefore opens with the full treble
 * clef and a key signature in treble positions) and goes back to bass at bar 6. The notes are the same pitches written in
 * whichever clef is in force, so the ledger lines and positions show the change took effect.
 */
export function clefChangeChart(): Score {
  const ids = createIdFactory();
  const make = (number: number): BarBuilder => new BarBuilder(ids, { number });
  const count = 8;
  const top = Array.from({ length: count }, (_, i) =>
    make(i + 1).chord(1, ['A', 'F#m7', 'Bm7', 'E7'][i % 4]!, BEAT).note('C#5', q).note('E5', q).note('A4', q).note('B4', q).build(),
  );
  const low = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const b = make(n);
    // Bass-range notes in bars 1-2, treble-range ones from bar 3, back to bass at 6.
    return (n === 1 || n === 2 || n >= 6
      ? b.note('A2', q).note('E3', q).note('A3', q).note('C#3', q)
      : b.note('A4', q).note('C#5', q).note('E5', q).note('A5', q)
    ).build();
  });
  const score = makeStaffedScore({
    id: 'clef-change',
    title: 'Clef Change at a Bar',
    composer: 'fixture',
    key: { tonic: 'A', alter: 0, mode: 'major' },
    bars: top,
    parts: [
      {
        name: 'Piano',
        instrument: 0,
        staves: [
          { clef: 'treble', bars: top.map((view) => voiceOfView(view)) },
          { clef: 'bass', bars: low.map((view) => voiceOfView(view)) },
        ],
      },
    ],
  });
  const lower = score.parts[0]!.staves[1]!;
  const at = (n: number) => lower.bars.find((bar) => bar.barId === score.bars[n - 1]!.id)!;
  at(3).clef = 'treble';
  at(6).clef = 'bass';
  return score;
}
