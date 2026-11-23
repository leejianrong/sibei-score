import type { BarView, Score } from '@sibei/model';
import { createIdFactory, dur, makeStaffedScore, voiceOfView } from '@sibei/model';
import type { VoiceInit } from '@sibei/model';
import { BarBuilder } from './builder.js';

/**
 * The fixtures slice 4 of ADR-0041 (SIB2-228) adds to the multi-staff set, to proof what the engraver does where staves
 * and voices meet. Same construction as `multi-staff-charts.ts`: hand-built, none of it music worth playing.
 */

const BEAT = 480;
const q = dur(4);
const h = dur(2);
const e = dur(8);

function maker(ids: ReturnType<typeof createIdFactory>): (number: number) => BarBuilder {
  return (number) => new BarBuilder(ids, { number });
}

function bars(count: number, write: (number: number) => BarBuilder | BarBuilder[]): (VoiceInit | VoiceInit[])[] {
  return Array.from({ length: count }, (_, index) => {
    const built = write(index + 1);
    const list = Array.isArray(built) ? built : [built];
    const voices = list.map((builder) => voiceOfView(builder.build()));
    return voices.length === 1 ? voices[0]! : voices;
  });
}

function grid(count: number, write: (number: number) => BarBuilder): BarView[] {
  return Array.from({ length: count }, (_, index) => write(index + 1).build());
}

const CHORDS = ['Cmaj7', 'A7', 'Dm7', 'G7'];

/**
 * The places two voices on one staff meet: a unison of the same head (shared), a second (the lower voice's head moves
 * aside), a unison of different heads, a crossing, an accidental on a moved head, a whole-bar rest in one voice, an
 * eighth triplet and a tie in the lower voice, and a third voice stemming up beside the first. Each bar is one case, so a
 * proof shows them one by one.
 */
export function voiceCollisionsChart(): Score {
  const ids = createIdFactory();
  const make = maker(ids);
  const count = 4;
  const upper = (n: number): BarBuilder => {
    const b = make(n).chord(1, CHORDS[(n - 1) % 4]!, BEAT);
    switch (n) {
      case 1:
        // A unison of the same head, a second, a unison of different heads.
        return b.note('E5', q).note('F5', q).note('D5', h);
      case 2:
        // A second with an accidental on the lower voice's head, a crossing (the lower voice above), then a rest.
        return b.note('F5', q).note('B4', q).rest(h);
      case 3:
        return b.rest(dur(1));
      default:
        return b.note('G5', h).note('A5', h);
    }
  };
  const lower = (n: number): BarBuilder => {
    const b = make(n);
    switch (n) {
      case 1:
        return b.note('E5', q).note('E5', q).note('D5', q).note('A4', q);
      case 2:
        return b.note('Eb5', q).note('D5', q).note('G4', h);
      case 3:
        return b.tuplet(3, 2, (t) => t.note('C5', e).note('D5', e).note('E5', e)).note('F4', q).note('C5', h, 'start');
      default:
        return b.note('C5', h, 'stop').note('C5', h);
    }
  };
  const third = (n: number): BarBuilder => make(n).note('F5', h).note('E5', h);
  return makeStaffedScore({
    id: 'voice-collisions',
    title: 'Voice Collisions',
    composer: 'fixture',
    bars: grid(count, upper),
    parts: [
      {
        name: 'Melody',
        staves: [
          {
            clef: 'treble',
            bars: bars(count, (n) => (n === 4 ? [upper(n), lower(n), third(n)] : [upper(n), lower(n)])),
          },
        ],
      },
    ],
  });
}

/**
 * Every pitched clef at once, in a key with flats: a treble, an alto, a tenor and a bass staff, each in its own part so a
 * bracket joins them, each with the key signature drawn in that clef's own positions. A tab staff is not drawn yet.
 */
export function clefsAndKeysChart(): Score {
  const ids = createIdFactory();
  const make = maker(ids);
  const count = 4;
  const line = (low: string, mid: string, high: string): ((n: number) => BarBuilder) => (n) =>
    make(n).note(low, q).note(mid, q).note(high, q).note(mid, q);
  const treble = line('Ab4', 'C5', 'Eb5');
  const alto = line('Ab3', 'C4', 'Eb4');
  const tenor = line('Ab3', 'Db4', 'F4');
  const bass = line('Ab2', 'C3', 'Eb3');
  const score = makeStaffedScore({
    id: 'clefs-and-keys',
    title: 'Clefs and Keys',
    composer: 'fixture',
    key: { tonic: 'A', alter: -1, mode: 'major' },
    bars: grid(count, (n) => treble(n)),
    parts: [
      { name: 'Violin', instrument: 40, staves: [{ clef: 'treble', bars: bars(count, treble) }] },
      { name: 'Viola', instrument: 41, staves: [{ clef: 'alto', bars: bars(count, alto) }] },
      { name: 'Trombone', instrument: 57, staves: [{ clef: 'tenor', bars: bars(count, tenor) }] },
      { name: 'Cello', instrument: 42, staves: [{ clef: 'bass', bars: bars(count, bass) }] },
    ],
  });
  return { ...score, meta: { ...score.meta, layout: 'score' } };
}
