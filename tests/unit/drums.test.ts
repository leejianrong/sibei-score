import { describe, expect, it } from 'vitest';
import { OperationError, applyOperation } from '@sibei/api';
import type { Operation } from '@sibei/api';
import {
  DRUMS,
  GM_DRUM_HIGH,
  GM_DRUM_LOW,
  allStaves,
  barViews,
  drumById,
  drumForGm,
  drumOfNoteEvent,
  headOf,
  isDrumKitStaff,
  parseDrum,
  projectScore,
} from '@sibei/model';
import type { Note, Score } from '@sibei/model';
import { drumChart, fullBandChart } from '@sibei/fixtures';
import { renderScoreToSvg } from '@sibei/pdf';
import { writtenPart } from '@sibei/music';

/** The drum map (ADR-0041 slice 6): conventions, General MIDI coverage, names, and the ops that set a drum. */

/** Half spaces below the top line, counting treble: F5 is 0, E4 (the bottom line) is 8. */
const STEP_INDEX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 } as const;
function position(id: Parameters<typeof drumById>[0]): number {
  const { step, octave } = drumById(id).pitch;
  return 5 * 7 + STEP_INDEX.F - (octave * 7 + STEP_INDEX[step]);
}

describe('the drum map', () => {
  it('writes the conventional places on five lines (positions are half spaces below the top line)', () => {
    expect(position('kick')).toBe(7); // bottom space
    expect(position('snare')).toBe(3); // third space from the bottom
    expect(position('hihat')).toBe(-1); // above the top line
    expect(position('ride')).toBe(0); // top line
    expect(position('crash')).toBe(-2); // first ledger line above
    expect(position('tom-high')).toBe(1); // top space
    expect(position('floor-tom')).toBe(6);
    expect(position('hihat-pedal')).toBe(9); // below the bottom line
  });

  it('draws cymbals as x, an open hi-hat circled, a bell as a diamond, and drums plain', () => {
    expect(drumById('hihat').head).toBe('x');
    expect(drumById('hihat-open').head).toBe('circle-x');
    expect(drumById('ride').head).toBe('x');
    expect(drumById('crash').head).toBe('x');
    expect(drumById('ride-bell').head).toBe('diamond');
    expect(drumById('snare').head).toBe('normal');
    expect(drumById('tom-low').head).toBe('normal');
  });

  it('puts the feet in voice 2 and the hands in voice 1', () => {
    expect(drumById('kick').voice).toBe(2);
    expect(drumById('hihat-pedal').voice).toBe(2);
    for (const drum of DRUMS.filter((d) => d.id !== 'kick' && d.id !== 'hihat-pedal')) expect(drum.voice).toBe(1);
  });

  it('keeps toms descending by pitch, from the top space down', () => {
    const order = ['tom-high', 'tom-high-mid', 'tom-low-mid', 'tom-low', 'floor-tom', 'floor-tom-low'] as const;
    const places = order.map((id) => position(id));
    expect([...places].sort((a, b) => a - b)).toEqual(places);
    expect(new Set(places).size).toBe(places.length);
  });

  it('maps General MIDI percussion keys 35 to 81 to a drum, or to nothing, never wrongly', () => {
    for (const key of [35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 59]) {
      expect(drumForGm(key), `GM ${key}`).not.toBeNull();
    }
    expect(drumForGm(36)).toBe('kick');
    expect(drumForGm(35)).toBe('kick');
    expect(drumForGm(38)).toBe('snare');
    expect(drumForGm(42)).toBe('hihat');
    expect(drumForGm(46)).toBe('hihat-open');
    expect(drumForGm(44)).toBe('hihat-pedal');
    expect(drumForGm(49)).toBe('crash');
    expect(drumForGm(51)).toBe('ride');
    expect(drumForGm(53)).toBe('ride-bell');
    expect(drumForGm(34)).toBeNull();
    expect(drumForGm(100)).toBeNull();
    expect(GM_DRUM_LOW).toBe(35);
    expect(GM_DRUM_HIGH).toBe(81);
  });

  it('round-trips each drum through its own General MIDI key (the key MusicXML writes)', () => {
    for (const drum of DRUMS.filter((d) => d.id !== 'percussion')) expect(drumForGm(drum.gm), drum.id).toBe(drum.id);
  });

  it('reads names, aliases and the transcriber drum_class, a recognised class winning over the key', () => {
    expect(parseDrum('Hi-Hat')).toBe('hihat');
    expect(parseDrum('open_hihat')).toBe('hihat-open');
    expect(parseDrum('HH')).toBe('hihat');
    expect(parseDrum('Bass Drum')).toBe('kick');
    expect(parseDrum('banjo')).toBeNull();
    expect(drumOfNoteEvent(38, 'kick')).toBe('kick');
    expect(drumOfNoteEvent(38, 'mystery')).toBe('snare');
    expect(drumOfNoteEvent(38, null)).toBe('snare');
    expect(drumOfNoteEvent(34, undefined)).toBeNull();
  });

  it("gives a note its own head, else its drum's", () => {
    expect(headOf({ drum: 'hihat' })).toBe('x');
    expect(headOf({ drum: 'hihat', head: 'diamond' })).toBe('diamond');
    expect(headOf({})).toBe('x');
  });
});

describe('drum notes through the ops', () => {
  const q = { value: 4, dots: 0 };
  const start: Operation[] = [
    { type: 'score.create', payload: { id: 'kit', barCount: 2 } },
    { type: 'staff.add', payload: { type: 'percussion', clef: 'percussion' } },
  ] as Operation[];
  function run(operations: Operation[]): Score {
    let score: Score | null = null;
    for (const operation of operations) score = applyOperation(score, operation).score;
    return score!;
  }
  const refusal = (operations: Operation[]): string => {
    try {
      run(operations);
    } catch (error) {
      if (error instanceof OperationError) return (error.failure as { detail: string }).detail;
      throw error;
    }
    throw new Error('expected a refusal');
  };
  const percussionNote = (score: Score): Note =>
    allStaves(score)[1]!.bars[0]!.voices[0]!.items.find((item): item is Note => item.kind === 'note')!;
  const add = (payload: object, target = 's2.bar1.beat1'): Operation => ({ type: 'note.add', target, payload }) as Operation;

  it('adds a drum by name: the display pitch comes from the map and the staff becomes a kit', () => {
    const score = run([...start, add({ drum: 'Hi-Hat', duration: q })]);
    const hit = percussionNote(score);
    expect(hit.drum).toBe('hihat');
    expect(hit.pitch).toEqual({ step: 'G', alter: 0, octave: 5 });
    expect(isDrumKitStaff(allStaves(score)[1]!)).toBe(true);
    expect(isDrumKitStaff(allStaves(score)[0]!)).toBe(false);
  });

  it('sets and clears a drum and a head, and shows the drum in the text projection', () => {
    const added = run([...start, add({ drum: 'snare', duration: q })]);
    const set = applyOperation(added, { type: 'note.set', target: 's2.bar1.n1', payload: { drum: 'ride', head: 'diamond' } } as Operation).score;
    expect(percussionNote(set)).toMatchObject({ drum: 'ride', head: 'diamond' });
    expect(projectScore(set)).toContain('ride/4:diamond');
    const cleared = applyOperation(set, { type: 'note.set', target: 's2.bar1.n1', payload: { head: null, drum: null } } as Operation).score;
    expect(percussionNote(cleared).drum).toBeUndefined();
    expect(percussionNote(cleared).head).toBeUndefined();
  });

  it('refuses a drum off a percussion staff, an unknown drum or head, and a pitch beside a drum', () => {
    const pitched: Operation[] = [{ type: 'score.create', payload: { id: 'x', barCount: 1 } } as Operation];
    expect(refusal([...pitched, add({ drum: 'kick', duration: q }, 'bar1.beat1')])).toContain('percussion staff');
    expect(refusal([...start, add({ drum: 'banjo', duration: q })])).toContain('not a drum');
    expect(refusal([...start, add({ drum: 'kick', head: 'star', duration: q })])).toContain('not a notehead');
    expect(refusal([...start, add({ drum: 'kick', pitch: 'C4', duration: q })])).toContain('takes no pitch');
  });

  it('does not transpose a drum, in the op or in a written part', () => {
    const kit = drumChart();
    const places = (score: Score): string[] =>
      barViews(score).flatMap((bar) => bar.items.flatMap((item) => (item.kind === 'note' ? [JSON.stringify(item.pitch)] : [])));
    const before = places(kit);
    expect(before.length).toBeGreaterThan(20);
    const moved = applyOperation(kit, { type: 'transpose', payload: { to: { tonic: 'D', alter: 0, mode: 'major' } } } as Operation).score;
    expect(places(moved)).toEqual(before);
    expect(places(writtenPart(kit, 'eb-alto'))).toEqual(before);
  });
});

describe('the drum fixture', () => {
  it('is a kit with hands in voice 1, feet in voice 2 and a second hand voice where hits coincide', () => {
    const kit = drumChart();
    expect(isDrumKitStaff(allStaves(kit)[0]!)).toBe(true);
    expect(allStaves(kit)[0]!.bars[0]!.voices.map((v) => v.index)).toEqual([1, 2, 3]);
    expect(barViews(kit)).toHaveLength(5);
  });
});

describe('the engraver on a drum kit', () => {
  const count = (svg: string, cls: string): number => (svg.match(new RegExp(`class="${cls}"`, 'g')) ?? []).length;
  const svgOf = (score: Score): string => renderScoreToSvg(score).map((page) => page.svg).join('');

  it('draws five lines for a kit (two systems of one staff) and a ledger line under the crash', () => {
    const svg = svgOf(drumChart());
    expect(count(svg, 'se-stafflines')).toBe(10);
    expect(count(svg, 'se-ledgerline')).toBeGreaterThan(0);
  });

  it('still draws a percussion staff with no named drum as the one line it always was', () => {
    const band = fullBandChart();
    const kitless = allStaves(band).filter((staff) => staff.type === 'percussion');
    expect(kitless.length).toBe(1);
    expect(isDrumKitStaff(kitless[0]!)).toBe(false);
  });
});
