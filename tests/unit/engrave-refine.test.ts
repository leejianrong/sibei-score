import { engravePage } from '@sibei/engrave';
import { clefChangeChart, fermatasStavesChart, ottavaStavesChart, voiceCollisionsChart } from '@sibei/fixtures';
import { crossingFlips, layout } from '@sibei/layout';
import { dur as makeDur } from '@sibei/model';
import type { Score } from '@sibei/model';
import { describe, expect, it } from 'vitest';

/**
 * SIB2-233: the four defects ADR-0041's slice 4 left. The proofs (`pnpm proof voice-collisions|ottava-staves|
 * fermatas-staves`) are where each was looked at; this file pins what was seen.
 */

const render = (score: Score): string => engravePage(layout(score), 0).svg;
const count = (svg: string, needle: string): number => svg.split(needle).length - 1;
const dur = (value: 1 | 2 | 4 | 8) => makeDur(value);
const p = (step: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B', octave: number) => ({ step, alter: 0 as const, octave });

describe('voices that cross turn their stems away from each other', () => {
  it('reverses both stems where the upper voice lies below the lower, and nowhere else', () => {
    const flips = crossingFlips([
      { index: 1, notes: [{ id: 'a', onset: 0, pitch: p('B', 4), duration: dur(4) }, { id: 'c', onset: 480, pitch: p('F', 5), duration: dur(4) }] },
      { index: 2, notes: [{ id: 'b', onset: 0, pitch: p('D', 5), duration: dur(4) }, { id: 'd', onset: 480, pitch: p('E', 5), duration: dur(4) }] },
    ]);
    expect([...flips].sort()).toEqual(['a', 'b']);
  });

  it('leaves a beamed note alone, since a beam shares its group direction', () => {
    const flips = crossingFlips([
      { index: 1, notes: [{ id: 'a', onset: 0, pitch: p('B', 4), duration: dur(8) }] },
      { index: 2, notes: [{ id: 'b', onset: 0, pitch: p('D', 5), duration: dur(4) }] },
    ]);
    expect(flips.size).toBe(0);
  });
});

describe('a third voice on the first voice\'s stem', () => {
  it('draws one stem for voices 1 and 3 striking the same duration together', () => {
    // voice-collisions bar 4: a snapshot of 23 stems drew voice 3's two beside voice 1's; now they are shared.
    expect(count(render(voiceCollisionsChart()), 'class="se-stem"')).toBe(21);
  });
});

describe('an ottava line on a staff below the top one', () => {
  it('draws the 8vb under the bass staff and reserves its room there', () => {
    const result = layout(ottavaStavesChart());
    const system = result.pages[0]!.systems[0]!;
    expect(system.ottavas.map((line) => [line.shift, line.staff ?? 0])).toEqual([['up', 0], ['down', 1]]);
    expect(system.staves?.[1]?.ottavaBelowOffset).toBeGreaterThan(0);
    expect(system.staves?.[0]?.ottavaBelowOffset).toBeUndefined();
    const svg = render(ottavaStavesChart());
    expect(count(svg, '>8vb<')).toBe(1);
    expect(count(svg, '>8va<')).toBe(1);
  });
});

describe('a fermata under its note', () => {
  it('hangs under a note below the staff and under a stem-down voice, above everything else', () => {
    const svg = render(fermatasStavesChart());
    // Bass E2 (below the staff) and voice 2's whole note take the inverted fermata; three others stay above.
    expect(count(svg, 'se-fermataBelow')).toBe(2);
    expect(count(svg, 'se-fermataAbove')).toBe(3);
  });
});

describe('a clef change at a bar (SIB2-241)', () => {
  const small = (svg: string): number => count(svg, 'se-grace se-gClef') + count(svg, 'se-grace se-fClef');

  it('draws a small clef in the lead-in of the bar that changes, and none at a system head', () => {
    const systems = layout(clefChangeChart()).pages[0]!.systems;
    // Bar 3 changes bass to treble mid-system, bar 6 back to bass mid-system; bar 5 heads a system and draws it full size.
    const changes = systems.flatMap((s) =>
      s.staves![1]!.bars.flatMap((bar) => bar.voices[0]!.items.filter((item) => item.kind === 'clef' && item.change === true)),
    );
    expect(changes.map((item) => (item.kind === 'clef' ? item.clef : ''))).toEqual(['treble', 'bass']);
    const opening = systems[1]!.staves![1]!.bars[0]!.voices[0]!.items.find((item) => item.kind === 'clef');
    expect(opening).toMatchObject({ clef: 'treble' });
    expect(opening).not.toHaveProperty('change');
    expect(small(render(clefChangeChart()))).toBe(2);
  });

  it('reads the notes after the change in the new clef', () => {
    const [first] = layout(clefChangeChart()).pages[0]!.systems;
    const bars = first!.staves![1]!.bars;
    expect(bars[0]!.clef).toBeUndefined();
    expect(bars[2]!.clef).toBe('treble');
  });

  it('makes room in the lead-in, so the bar is wider by the small clef', () => {
    const [first] = layout(clefChangeChart()).pages[0]!.systems;
    expect(first!.bars[2]!.prefixWidth).toBeGreaterThan(first!.bars[1]!.prefixWidth);
    expect(first!.bars[2]!.prefix.clefChange).toBe(true);
  });
});
