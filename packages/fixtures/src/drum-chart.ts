import type { Score } from '@sibei/model';
import { createIdFactory, dur, makeStaffedScore, voiceOfView } from '@sibei/model';
import type { VoiceInit } from '@sibei/model';
import { BarBuilder } from './builder.js';

/**
 * A drum kit on a five-line percussion staff (ADR-0041 slice 6), hand-built, two voices of hands and one of feet:
 *
 *  1-2  a basic rock beat: hi-hat in eighths (voice 1), the snare on 2 and 4 (voice 3, so it shares the hi-hat's
 *       stem), the kick on 1 and 3 (voice 2, stems down); bar 2 adds a kick on the "and" of 3
 *  3    a fill: sixteenths on the snare, then the toms from the first space down to the floor tom
 *  4    a crash with the kick, an open hi-hat, and the pedal hi-hat on 3 below the staff
 *  5    a ride pattern whose last beat is the bell (a diamond), the pedal hi-hat keeping time
 *
 * Voice 3 is only there for hits that share a moment with voice 1; its rests are not drawn. Chosen to put the drum
 * map's every kind of place under the engraver (a ledger line above, a note below the staff, an x, a circled x, a
 * diamond and the plain heads), and none of it is a groove worth keeping.
 */

const q = dur(4);
const e = dur(8);
const s = dur(16);

function bars(count: number, write: (number: number) => BarBuilder[]): (VoiceInit | VoiceInit[])[] {
  return Array.from({ length: count }, (_, index) => {
    const voices = write(index + 1).map((builder) => voiceOfView(builder.build()));
    return voices.length === 1 ? voices[0]! : voices;
  });
}

export function drumChart(): Score {
  const ids = createIdFactory();
  const make = (number: number): BarBuilder => new BarBuilder(ids, { number });
  const count = 5;
  const write = (n: number): BarBuilder[] => {
    const hands = make(n);
    const snare = make(n);
    const feet = make(n);
    switch (n) {
      case 1:
      case 2:
        for (let i = 0; i < 8; i += 1) hands.drum('hihat', e);
        snare.rest(q).drum('snare', q).rest(q).drum('snare', q);
        if (n === 1) feet.drum('kick', q).rest(q).drum('kick', q).rest(q);
        else feet.drum('kick', q).rest(q).drum('kick', e).drum('kick', e).rest(q);
        return [hands, feet, snare];
      case 3:
        for (let i = 0; i < 4; i += 1) hands.drum('snare', s);
        for (const drum of ['tom-high', 'tom-high-mid', 'tom-low-mid', 'tom-low', 'floor-tom', 'floor-tom'] as const) {
          hands.drum(drum, s).drum(drum, s);
        }
        return [hands];
      case 4:
        hands.drum('crash', q).drum('hihat-open', q).rest(q).drum('hihat', q);
        feet.drum('kick', q).rest(q).drum('hihat-pedal', q).rest(q);
        return [hands, feet];
      default:
        hands.drum('ride', q).drum('ride', q).drum('ride', q).drum('ride-bell', q);
        feet.rest(q).drum('hihat-pedal', q).rest(q).drum('hihat-pedal', q);
        return [hands, feet];
    }
  };
  const grid = Array.from({ length: count }, (_, index) => make(index + 1).build());
  return makeStaffedScore({
    id: 'drum-kit',
    title: 'Drum Kit',
    composer: 'fixture',
    bars: grid,
    parts: [{ name: 'Drums', staves: [{ type: 'percussion', bars: bars(count, write) }] }],
  });
}
