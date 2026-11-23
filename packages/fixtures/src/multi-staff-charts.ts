import type { BarView, Score } from '@sibei/model';
import { createIdFactory, dur, makeStaffedScore, voiceOfView } from '@sibei/model';
import type { VoiceInit } from '@sibei/model';
import { BarBuilder } from './builder.js';

/**
 * The multi-staff fixtures (ADR-0041, SIB2-227): hand-built `Score`s with more than one staff or voice, so layout can be
 * proofed and tested before any op can create a staff (slice 2) or the engraver can draw one (slice 4). Each is chosen
 * to put a different pressure on time alignment, staff spacing or grouping, and none is music worth playing.
 *
 * A bar is written as a `BarBuilder` per staff and voice; the first staff's builder also carries the chords, which are
 * the harmony lane above the top staff (ADR-0041 section 3).
 */

const BEAT = 480;
const q = dur(4);
const h = dur(2);
const e = dur(8);
const s = dur(16);

type Make = (number: number) => BarBuilder;

function maker(ids: ReturnType<typeof createIdFactory>): Make {
  return (number) => new BarBuilder(ids, { number });
}

/** The voices of one staff in one bar, from builders. */
function bars(count: number, write: (number: number) => BarBuilder | BarBuilder[]): (VoiceInit | VoiceInit[])[] {
  return Array.from({ length: count }, (_, index) => {
    const built = write(index + 1);
    const list = Array.isArray(built) ? built : [built];
    const voices = list.map((builder) => voiceOfView(builder.build()));
    return voices.length === 1 ? voices[0]! : voices;
  });
}

/** The grid (and the harmony) is the first builder's own bar. */
function grid(count: number, write: (number: number) => BarBuilder): BarView[] {
  return Array.from({ length: count }, (_, index) => write(index + 1).build());
}

const CHORDS = ['Cmaj7', 'A7', 'Dm7', 'G7'];

/**
 * A piano's grand staff: treble over bass in one part, so a brace, with the right hand moving in eighths over a left
 * hand in quarters and halves (so onsets on the two staves only sometimes coincide), a high C6 and a low E2 for
 * ledger-line room between the staves, and chords above the top staff.
 */
export function grandStaffChart(): Score {
  const ids = createIdFactory();
  const make = maker(ids);
  const count = 8;
  const right = (n: number): BarBuilder => {
    const b = make(n).chord(1, CHORDS[(n - 1) % 4]!, BEAT);
    if (n % 4 === 0) return b.note('C6', q).note('B5', q).note('G5', h);
    return b.note('E5', e).note('G5', e).note('C6', e).note('B5', e).note('G5', q).note('E5', q);
  };
  const left = (n: number): BarBuilder => {
    const b = make(n);
    if (n % 4 === 0) return b.note('E2', dur(1));
    if (n % 2 === 0) return b.note('C3', h).note('G2', q).note('E3', q);
    return b.note('C3', q).note('G3', q).note('E3', h);
  };
  return makeStaffedScore({
    id: 'grand-staff',
    title: 'Grand Staff',
    composer: 'fixture',
    bars: grid(count, right),
    parts: [
      {
        name: 'Piano',
        instrument: 0,
        staves: [
          { clef: 'treble', bars: bars(count, right) },
          { clef: 'bass', bars: bars(count, left) },
        ],
      },
    ],
  });
}

/**
 * Two voices on one staff: voice 1 in eighths and quarters, voice 2 in halves and a rest, sharing bars, so the stems
 * run apart and the onsets of the two voices interleave (a voice-2 half note lands under every other voice-1 note).
 */
export function twoVoiceChart(): Score {
  const ids = createIdFactory();
  const make = maker(ids);
  const count = 4;
  const upper = (n: number): BarBuilder => {
    const b = make(n).chord(1, CHORDS[(n - 1) % 4]!, BEAT);
    return n % 2 === 1
      ? b.note('G5', e).note('A5', e).note('B5', q).note('C6', q).note('B5', q)
      : b.note('E5', q).note('G5', e).note('F5', e).note('E5', h);
  };
  const lower = (n: number): BarBuilder => {
    const b = make(n);
    return n === 3 ? b.rest(h).note('C4', h) : b.note('C4', h).note('E4', h);
  };
  return makeStaffedScore({
    id: 'two-voice',
    title: 'Two Voices',
    composer: 'fixture',
    bars: grid(count, upper),
    parts: [
      {
        name: 'Melody',
        staves: [{ clef: 'treble', bars: bars(count, (n) => [upper(n), lower(n)]) }],
      },
    ],
  });
}

/**
 * A lead sheet with a bass staff under it: two parts, so a bracket. The chords sit above the lead staff only (not
 * above the bass), and the bass walks in quarters under a melody of mixed values.
 */
export function leadBassChart(): Score {
  const ids = createIdFactory();
  const make = maker(ids);
  const count = 8;
  const lead = (n: number): BarBuilder => {
    const b = make(n).chord(1, CHORDS[(n - 1) % 4]!, BEAT);
    if (n % 3 === 0) return b.note('A5', dur(4, 1)).note('G5', e).note('E5', h);
    return b.note('E5', q).note('G5', q).note('B4', e).note('D5', e).note('C5', q);
  };
  const bass = (n: number): BarBuilder => {
    const root = ['C3', 'A2', 'D3', 'G2'][(n - 1) % 4]!;
    return make(n).note(root, q).note('E3', q).note('G3', q).note('F#2', q);
  };
  return makeStaffedScore({
    id: 'lead-bass',
    title: 'Lead and Bass',
    composer: 'fixture',
    bars: grid(count, lead),
    parts: [
      { name: 'Lead', instrument: 65, staves: [{ clef: 'treble', bars: bars(count, lead) }] },
      { name: 'Bass', instrument: 32, staves: [{ clef: 'bass', bars: bars(count, bass) }] },
    ],
  });
}

/**
 * A whole band system: lead, piano (a grand staff), bass and a percussion staff, so a bracket around the lot and a brace
 * inside it, eighths (and one bar of sixteenths) on the hi-hat against quarters elsewhere, and `meta.layout: 'score'` so the systems break by
 * width, not by the four-bar grid. Sixteen bars of five staves is two pages, which is the page-capacity case.
 */
export function fullBandChart(): Score {
  const ids = createIdFactory();
  const make = maker(ids);
  const count = 16;
  const lead = (n: number): BarBuilder => {
    const b = make(n).chord(1, CHORDS[(n - 1) % 4]!, BEAT);
    return b.note('E5', h).note('G5', q).note('E5', q);
  };
  const rh = (n: number): BarBuilder => make(n).note('G4', q).note('C5', q).note('E5', e).note('D5', e).note('C5', q);
  const lh = (n: number): BarBuilder => make(n).note('C3', h).note('G2', h);
  const bass = (n: number): BarBuilder => make(n).note('C2', q).note('G2', q).note('C3', q).note('G2', q);
  const drums = (n: number): BarBuilder => {
    const b = make(n);
    // Eighths on the hi-hat, with one bar of sixteenths for the densest column the band has.
    if (n === 5) for (let i = 0; i < 8; i += 1) b.note('F5', s).note('F5', s);
    else for (let i = 0; i < 8; i += 1) b.note('F5', e);
    return b;
  };
  const score = makeStaffedScore({
    id: 'full-band',
    title: 'Full Band',
    composer: 'fixture',
    bars: grid(count, lead),
    parts: [
      { name: 'Lead', instrument: 65, staves: [{ clef: 'treble', bars: bars(count, lead) }] },
      {
        name: 'Piano',
        instrument: 0,
        staves: [
          { clef: 'treble', bars: bars(count, rh) },
          { clef: 'bass', bars: bars(count, lh) },
        ],
      },
      { name: 'Bass', instrument: 32, staves: [{ clef: 'bass', bars: bars(count, bass) }] },
      { name: 'Drums', staves: [{ type: 'percussion', bars: bars(count, drums) }] },
    ],
  });
  return { ...score, meta: { ...score.meta, layout: 'score' } };
}
