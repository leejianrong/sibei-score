import type { BeamMember, StemDirection } from '@sibei/engrave';
import {
  MAX_BEAM_GRADIENT,
  PARTIAL_BEAM,
  STANDARD_STEM,
  applyBeam,
  beamLine,
  beamSegments,
  beamYAt,
  groupStemDirection,
  positionY,
  slantLimit,
  stem,
} from '@sibei/engrave';
import { describe, expect, it } from 'vitest';

/**
 * Beam geometry, which ADR-0030 calls the hard part and the main risk.
 *
 * The three claims the V1b test plan asks for — slope within the conventional limit,
 * every stem terminating on the beam, and four sixteenths getting two beams — plus the
 * one the V1 bug argues for: that a group's stems come out at a sensible length rather
 * than merely at a consistent one.
 */

const STAVE_Y = 200;

/** A beamable group at `positions`, spaced evenly, with a beam level each. */
function group(
  positions: readonly number[],
  levels: readonly number[] = positions.map(() => 2),
  spacing = 15,
): { members: BeamMember[]; direction: StemDirection } {
  const direction = groupStemDirection(positions);
  const members = positions.map((position, index) => ({
    stem: stem({
      notehead: 'noteheadBlack',
      direction,
      noteX: 100 + index * spacing,
      position,
      staveY: STAVE_Y,
    }),
    position,
    levels: levels[index] ?? 2,
  }));
  return { members, direction };
}

/** Bar 6 of the nasty chart: Bb5, A natural 5, G5, F5 as sixteenths. */
function bar6Group(): { members: BeamMember[]; direction: StemDirection } {
  return group([-3, -2, -1, 0]);
}

describe('a beamed group takes one direction', () => {
  it('follows the note furthest from the middle line', () => {
    expect(groupStemDirection([-3, -2, -1, 0])).toBe('down');
    expect(groupStemDirection([12, 10, 8])).toBe('up');
    // Balanced about the middle line: down, by convention.
    expect(groupStemDirection([2, 6])).toBe('down');
    expect(groupStemDirection([4, 4])).toBe('down');
  });
});

describe('beam slope', () => {
  it('stays within the slant the outer interval allows', () => {
    const { members } = bar6Group();
    const line = beamLine(members);
    const first = members[0];
    const last = members[members.length - 1];
    if (first === undefined || last === undefined) throw new Error('no members');

    const rise = beamYAt(line, last.stem.centre) - beamYAt(line, first.stem.centre);
    expect(Math.abs(rise)).toBeLessThanOrEqual(slantLimit(last.position - first.position) + 1e-9);
  });

  it('stays within the maximum gradient however wide the leap', () => {
    // Two sixteenths an octave and a half apart, close together: the slant table alone
    // would allow more rise than the run can carry.
    const { members } = group([-4, 10], [2, 2], 12);
    const line = beamLine(members);
    expect(Math.abs(line.slope)).toBeLessThanOrEqual(MAX_BEAM_GRADIENT + 1e-9);
  });

  it('is flat when the outer notes are at the same height', () => {
    const { members } = group([0, -2, 0]);
    expect(beamLine(members).slope).toBe(0);
  });

  it('slants the way the music moves', () => {
    // Descending noteheads, stems down: the beam falls as it goes right.
    const { members } = bar6Group();
    const line = beamLine(members);
    expect(line.slope).toBeGreaterThan(0);
  });
});

describe('beam position and stem length', () => {
  it('ends every stem on the beam', () => {
    const { members } = bar6Group();
    const line = beamLine(members);
    applyBeam(line, members);
    for (const member of members) {
      expect(member.stem.endY).toBeCloseTo(beamYAt(line, member.stem.centre), 10);
    }
  });

  it('never shortens a stem below the standard length', () => {
    // Anchoring the beam on the note nearest it is what guarantees this. A beam fitted
    // to the outer notes alone would pinch the stem of an inner note that leans towards
    // the beam, which is the classic beaming defect.
    for (const positions of [
      [-3, -2, -1, 0],
      [0, -4, 2, -2],
      [8, 12, 10, 14],
      [4, 4, 4, 4],
    ]) {
      const { members } = group(positions);
      const line = beamLine(members);
      applyBeam(line, members);
      for (const member of members) {
        const noteY = positionY(member.position, STAVE_Y);
        expect(Math.abs(member.stem.endY - noteY)).toBeGreaterThanOrEqual(STANDARD_STEM - 1e-9);
      }
    }
  });
});

describe('how many beams, over which notes', () => {
  it('gives four sixteenths two full-width beams', () => {
    const { members } = bar6Group();
    const segments = beamSegments(members);
    expect(segments.map((segment) => segment.level)).toEqual([1, 2]);

    const first = members[0];
    const last = members[members.length - 1];
    if (first === undefined || last === undefined) throw new Error('no members');
    for (const segment of segments) {
      expect(segment.x1).toBeCloseTo(first.stem.left, 10);
      expect(segment.x2).toBeCloseTo(last.stem.right, 10);
    }
  });

  it('gives four eighths one beam', () => {
    const { members } = group([-3, -2, -1, 0], [1, 1, 1, 1]);
    expect(beamSegments(members).map((segment) => segment.level)).toEqual([1]);
  });

  it('covers only the run of notes that need the second beam', () => {
    // An eighth then two sixteenths: the second beam belongs to the last two only.
    const { members } = group([0, -1, -2], [1, 2, 2]);
    const segments = beamSegments(members);
    const second = segments.find((segment) => segment.level === 2);
    const middle = members[1];
    const last = members[2];
    if (second === undefined || middle === undefined || last === undefined) {
      throw new Error('no second beam');
    }
    expect(second.x1).toBeCloseTo(middle.stem.left, 10);
    expect(second.x2).toBeCloseTo(last.stem.right, 10);
  });

  it('stubs a partial beam back towards the note before it', () => {
    const { members } = group([0, -1, -2], [1, 2, 1]);
    const second = beamSegments(members).find((segment) => segment.level === 2);
    const middle = members[1];
    if (second === undefined || middle === undefined) throw new Error('no second beam');
    expect(second.x2).toBeCloseTo(middle.stem.right, 10);
    expect(second.x1).toBeCloseTo(middle.stem.left - PARTIAL_BEAM, 10);
  });

  it('stubs forwards when the partial beam is the first note of the group', () => {
    const { members } = group([0, -1, -2], [2, 1, 1]);
    const second = beamSegments(members).find((segment) => segment.level === 2);
    const first = members[0];
    if (second === undefined || first === undefined) throw new Error('no second beam');
    expect(second.x1).toBeCloseTo(first.stem.left, 10);
    expect(second.x2).toBeCloseTo(first.stem.right + PARTIAL_BEAM, 10);
  });
});
