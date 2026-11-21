import type { BeamCandidate } from '@sibei/engrave';
import { beamGroupIndices, beamSegments, secondaryBreaks } from '@sibei/engrave';
import type { BeamMember } from '@sibei/engrave';
import type { TimeSignature } from '@sibei/model';
import { describe, expect, it } from 'vitest';

/** SIB2-154: the grouping rules, with no engraver in the way. Rules are listed in beam-groups.ts. */

const FOUR_FOUR: TimeSignature = { beats: 4, beatValue: 4 };
const THREE_FOUR: TimeSignature = { beats: 3, beatValue: 4 };
const SIX_EIGHT: TimeSignature = { beats: 6, beatValue: 8 };
const CUT: TimeSignature = { beats: 2, beatValue: 2 };

/** 'e' eighth, 's' sixteenth, 'r' eighth rest, 'q' quarter; a tuplet id after `:` marks a triplet eighth. */
function bar(spec: string): BeamCandidate[] {
  let onset = 0;
  return spec.split(' ').map((token) => {
    const [kind, tuplet] = token.split(':');
    const triplet = tuplet !== undefined;
    const ticks = { e: 240, s: 120, r: 240, q: 480 }[kind ?? 'e'] ?? 240;
    const item: BeamCandidate = {
      kind: kind === 'r' ? 'rest' : 'note',
      onset,
      beamable: kind === 'e' || kind === 's',
      plainEighth: kind === 'e' && !triplet,
      tupletId: triplet ? tuplet : null,
    };
    onset += triplet ? (ticks * 2) / 3 : ticks;
    return item;
  });
}

const groups = (spec: string, time: TimeSignature): number[][] => beamGroupIndices(bar(spec), time);

describe('beam groups', () => {
  it('beams eighths by the beat in 3/4 and by the dotted quarter in 6/8', () => {
    expect(groups('e e e e e e', THREE_FOUR)).toEqual([[0, 1], [2, 3], [4, 5]]);
    expect(groups('e e e e e e', SIX_EIGHT)).toEqual([[0, 1, 2], [3, 4, 5]]);
  });

  it('beams four plain eighths of a half bar together in 4/4, never across the middle', () => {
    expect(groups('e e e e e e e e', FOUR_FOUR)).toEqual([[0, 1, 2, 3], [4, 5, 6, 7]]);
    // Beat 2 to beat 3 is the middle of the bar: q e e e e q must not join its inner four.
    expect(groups('q e e e e q', FOUR_FOUR)).toEqual([[1, 2], [3, 4]]);
  });

  it('keeps beat groups when the half bar holds a sixteenth, a rest or a triplet', () => {
    expect(groups('e s s e e e e e', FOUR_FOUR)).toEqual([[0, 1, 2], [3, 4], [5, 6]]);
    expect(groups('e r e e e e e e', FOUR_FOUR)).toEqual([[2, 3], [4, 5, 6, 7]]);
  });

  it('breaks at a rest and at a note too long to beam', () => {
    // The lone eighth after the rest (index 3) has nothing to beam to; the quarter ends the next group.
    expect(groups('e e r e e e q', FOUR_FOUR)).toEqual([[0, 1], [4, 5]]);
  });

  it('beams a cut-time half note of eighths as one group', () => {
    expect(groups('e e e e e e e e', CUT)).toEqual([[0, 1, 2, 3], [4, 5, 6, 7]]);
  });

  it('keeps a triplet whole, even where it straddles the beat line', () => {
    // An eighth, then an eighth triplet that starts half way through beat 1 and ends in beat 2.
    expect(groups('e e:a e:a e:a', FOUR_FOUR)).toEqual([[1, 2, 3]]);
    // Two triplets in one beat are two groups, never one.
    expect(groups('e:a e:a e:a e:b e:b e:b', FOUR_FOUR)).toEqual([[0, 1, 2], [3, 4, 5]]);
  });
});

describe('secondary beam breaks', () => {
  it('breaks at the quarter in cut time and at each eighth in 6/8, not within a beat of 4/4', () => {
    const sixteenths = [0, 120, 240, 360, 480, 600, 720, 840];
    expect(secondaryBreaks(sixteenths, CUT)).toEqual([false, false, false, false, true, false, false, false]);
    expect(secondaryBreaks([0, 120, 240, 360, 480, 600], SIX_EIGHT)).toEqual([false, false, true, false, true, false]);
    expect(secondaryBreaks([0, 120, 240, 360], FOUR_FOUR)).toEqual([false, false, false, false]);
  });

  it('cuts the second beam at a break and leaves the primary running', () => {
    const member = (centre: number, breakBefore: boolean): BeamMember => ({
      stem: { centre, left: centre - 1, right: centre + 1, endY: 0, direction: 'up' } as unknown as BeamMember['stem'],
      position: 0,
      levels: 2,
      breakBefore,
    });
    const segments = beamSegments([member(0, false), member(10, false), member(20, true), member(30, false)]);
    expect(segments.filter((segment) => segment.level === 1)).toHaveLength(1);
    expect(segments.filter((segment) => segment.level === 2)).toHaveLength(2);
  });
});
