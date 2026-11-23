import {
  PERCUSSION_LINE,
  engravePage,
  keySignature,
  musicFontNamed,
  noteShifts,
  positionY,
  restShiftOf,
  staffPosition,
  staffPositionIn,
  stemsOf,
  units,
} from '@sibei/engrave';
import { clefsAndKeysChart, fullBandChart, grandStaffChart, voiceCollisionsChart } from '@sibei/fixtures';
import type { LayoutBarItem, LayoutVoice } from '@sibei/layout';
import { layout } from '@sibei/layout';
import type { Clef, Score } from '@sibei/model';
import { describe, expect, it } from 'vitest';

/**
 * SIB2-228, slice 4 of ADR-0041: the engraver draws every staff a system lays out. The hard rule (a single-staff
 * single-voice chart is the bytes it always was) is held by the committed snapshots and by the browser-and-server
 * byte-identity test; this file pins what only a multi-staff system draws.
 */

const font = musicFontNamed('normal');

const render = (score: Score, page = 0): string => engravePage(layout(score), page).svg;
const count = (svg: string, needle: string): number => svg.split(needle).length - 1;

describe('where a pitch sits in each clef', () => {
  const pitch = (step: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G', octave: number) => ({ step, alter: 0 as const, octave });

  it('puts each clef top line where it belongs, and leaves treble alone', () => {
    expect(staffPositionIn(pitch('F', 5), 'treble')).toBe(0);
    expect(staffPositionIn(pitch('A', 3), 'bass')).toBe(0);
    expect(staffPositionIn(pitch('G', 4), 'alto')).toBe(0);
    expect(staffPositionIn(pitch('E', 4), 'tenor')).toBe(0);
    expect(staffPositionIn(pitch('C', 5), 'treble')).toBe(staffPosition(pitch('C', 5)));
  });

  it('puts the clef-naming line where the clef says: middle C on the middle line of alto, the fourth line of tenor', () => {
    expect(staffPositionIn(pitch('C', 4), 'alto')).toBe(4);
    expect(staffPositionIn(pitch('C', 4), 'tenor')).toBe(2);
    // Bass: F3 is the fourth line from the bottom, the second from the top.
    expect(staffPositionIn(pitch('F', 3), 'bass')).toBe(2);
  });

  it('puts every note of a percussion staff on its one line', () => {
    expect(staffPositionIn(pitch('C', 2), 'percussion')).toBe(PERCUSSION_LINE);
    expect(staffPositionIn(pitch('G', 6), 'percussion')).toBe(PERCUSSION_LINE);
  });
});

describe('a key signature in each clef', () => {
  const positions = (fifths: number, clef: Clef): number[] =>
    keySignature(font, fifths, 0, 0, clef).elements.map((element) => {
      const match = /translate\([^,]+,(-?[\d.]+)\)/.exec(String(element.attrs['transform']));
      return Number(match?.[1]) / 5;
    });

  it('is the treble pattern, unchanged, in treble', () => {
    expect(positions(3, 'treble')).toEqual([0, 3, -1]);
    expect(positions(-3, 'treble')).toEqual([4, 1, 5]);
  });

  it('moves with the clef and stays on the staff', () => {
    // First flat is B-flat: the second line from the bottom of bass (position 6), the space above A3 in alto (5).
    expect(positions(-1, 'bass')).toEqual([6]);
    expect(positions(-1, 'alto')).toEqual([5]);
    expect(positions(-1, 'tenor')).toEqual([3]);
    for (const clef of ['bass', 'alto', 'tenor'] as const) {
      for (const fifths of [7, -7]) {
        for (const position of positions(fifths, clef)) {
          expect(position).toBeGreaterThanOrEqual(-1);
          expect(position).toBeLessThanOrEqual(8);
        }
      }
    }
  });
});

describe('a multi-staff system draws every staff', () => {
  it('draws a brace for a part with two staves and a bracket across parts', () => {
    const grand = render(grandStaffChart());
    // Two systems on the page, a brace on each, and no bracket for a single part.
    expect(count(grand, 'class="se-brace"')).toBe(2);
    expect(count(grand, 'class="se-bracket"')).toBe(0);

    const band = render(fullBandChart());
    // Lead, piano (a brace), bass and drums: a bracket across, a brace in it, on each of the page's systems.
    expect(count(band, 'class="se-bracket"')).toBe(count(band, 'class="se-brace"'));
    expect(count(band, 'class="se-brace"')).toBeGreaterThan(0);
  });

  it('draws the clef of each staff, in its own glyph', () => {
    const svg = render(clefsAndKeysChart());
    expect(count(svg, 'se-gClef')).toBe(1);
    // Alto and tenor are both a C clef.
    expect(count(svg, 'se-cClef')).toBe(2);
    expect(count(svg, 'se-fClef')).toBe(1);
  });

  it('draws a percussion staff as one line with x noteheads and the percussion clef', () => {
    const result = layout(fullBandChart());
    const svg = engravePage(result, 0).svg;
    const systems = result.pages[0]?.systems.length ?? 0;
    // Each system is four five-line staves and one one-line staff.
    expect(count(svg, 'class="se-stafflines"')).toBe(systems * (4 * 5 + 1));
    expect(count(svg, 'se-unpitchedPercussionClef1')).toBeGreaterThan(0);
    expect(count(svg, 'se-noteheadXBlack')).toBeGreaterThan(0);
    // The drum notes are x heads, so no round head is drawn on them: the quarter heads on the page are the others'.
    expect(count(svg, 'se-noteheadXHalf')).toBe(0);
  });

  it('runs a barline through every staff of the system in one piece', () => {
    const result = layout(grandStaffChart());
    const system = result.pages[0]?.systems[0];
    const span = system?.staffSpan;
    expect(span).toBeDefined();
    const svg = engravePage(result, 0).svg;
    // One rect as tall as the whole stack: a single staff is four spaces, the stack is far taller.
    const tall = [...svg.matchAll(/class="se-barline se-barline-single" x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)"/g)]
      .map((match) => Number(match[2]))
      .filter((height) => height > units(4) * 2);
    expect(tall.length).toBeGreaterThanOrEqual(4);
    expect(tall[0]).toBeCloseTo(span?.height ?? 0, 3);
  });
});

describe('voices on one staff', () => {
  const voices = (score: Score): LayoutVoice[] => {
    const staff = layout(score).pages[0]?.systems[0]?.staves?.[0];
    return staff?.bars[0]?.voices ?? [];
  };
  const bars = (score: Score, bar: number): LayoutVoice[] =>
    layout(score).pages[0]?.systems[0]?.staves?.[0]?.bars[bar]?.voices ?? [];

  it('stems voices 1 and 3 up and 2 and 4 down, and a lone voice automatically', () => {
    const [one, two] = voices(voiceCollisionsChart());
    expect(one && two).toBeTruthy();
    const all = voices(voiceCollisionsChart());
    expect(stemsOf(all[0]!, all)).toBe('up');
    expect(stemsOf(all[1]!, all)).toBe('down');
    const three = bars(voiceCollisionsChart(), 3);
    expect(stemsOf(three[2]!, three)).toBe('up');
    // A staff with one voice with music has no forced direction, whatever voices it carries.
    const alone: LayoutVoice[] = [{ index: 1, stems: 'auto', items: all[0]!.items }, { index: 2, stems: 'auto', items: [] }];
    expect(stemsOf(alone[0]!, alone)).toBe('auto');
  });

  it('offsets rests up for the upper voice and down for the lower', () => {
    const all = bars(voiceCollisionsChart(), 1);
    expect(restShiftOf(all[0]!, all)).toBe(-2);
    expect(restShiftOf(all[1]!, all)).toBe(2);
  });

  it('moves a head a second below the other voice aside, shares a unison of one head, and leaves the upper voice be', () => {
    const all = voices(voiceCollisionsChart());
    const upperNotes = all[0]!.items.filter((item): item is Extract<LayoutBarItem, { kind: 'note' }> => item.kind === 'note');
    const lowerNotes = all[1]!.items.filter((item): item is Extract<LayoutBarItem, { kind: 'note' }> => item.kind === 'note');
    const shifts = noteShifts(font, { voice: all[1]!, voices: all, clef: 'treble' });
    // Beat 1: E5 over E5, the same quarter head, shared; beat 2: F5 over E5, a second, moved; beat 3: a half over a quarter on D5, moved.
    expect(shifts.has(lowerNotes[0]!.noteId)).toBe(false);
    expect(shifts.has(lowerNotes[1]!.noteId)).toBe(true);
    expect(shifts.has(lowerNotes[2]!.noteId)).toBe(true);
    // The A4 is alone on its beat.
    expect(shifts.has(lowerNotes[3]!.noteId)).toBe(false);
    // The upper voice outranks the lower and never moves.
    expect(noteShifts(font, { voice: all[0]!, voices: all, clef: 'treble' }).size).toBe(0);
    expect(upperNotes.length).toBe(3);
  });

  it('keeps the system as tall as its up stems, so the chord row clears them', () => {
    const system = layout(voiceCollisionsChart()).pages[0]?.systems[0];
    // G5/A5 with stems up stand four spaces over the top line; the chord baseline sits above that.
    expect(system?.chordBaselineOffset ?? 0).toBeGreaterThan(units(3.5));
    expect(positionY(0, 0)).toBe(0);
  });
});
