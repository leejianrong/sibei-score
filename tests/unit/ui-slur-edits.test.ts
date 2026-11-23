import { barViews } from '@sibei/model';
import { describe, expect, it } from 'vitest';
import { slurChart } from '@sibei/fixtures';
import { removeSlurOp, slurOp, slursOnNote } from '../../packages/ui/src/lib/slur-edits.js';

/** SIB2-168: the browser's slur control. Two shift-clicked notes, in either order, become one slur.set. */

describe('the slur control', () => {
  const score = slurChart();
  const first = barViews(score)[0]!.items[0]!.id;
  const third = barViews(score)[0]!.items[2]!.id;
  const rest = 'rest-nope';

  it('puts the two notes in reading order, whichever was clicked first', () => {
    const expected = { type: 'slur.set', target: first, payload: { to: third } };
    expect(slurOp(score, first, third, 'auto')).toEqual(expected);
    expect(slurOp(score, third, first, 'auto')).toEqual(expected);
  });

  it('carries a chosen placement and omits auto', () => {
    expect(slurOp(score, first, third, 'below')).toMatchObject({ payload: { placement: 'below' } });
    expect(slurOp(score, first, third, 'auto')).not.toHaveProperty('payload.placement');
  });

  it('makes nothing from the same note twice or from something that is not a note', () => {
    expect(slurOp(score, first, first, 'auto')).toBeNull();
    expect(slurOp(score, first, rest, 'auto')).toBeNull();
  });

  it('lists the slurs on a note, and removes one by id', () => {
    expect(slursOnNote(score, first).map((s) => s.id)).toEqual(['slur-1']);
    expect(slursOnNote(score, third)).toEqual([]);
    expect(removeSlurOp('slur-1')).toEqual({ type: 'slur.rm', target: 'slur-1' });
  });
});
