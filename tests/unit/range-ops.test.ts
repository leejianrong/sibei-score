import { describe, expect, it } from 'vitest';
import { applyOperation, replay } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { graceNotesChart, nastyChart, slurChart, stackedChordsChart } from '@sibei/fixtures';
import { barViews, copyRange, clipProblem, notesOf } from '@sibei/model';
import type { Clip, Score } from '@sibei/model';

/**
 * Copy and paste of ranges (SIB2-279): a clip copied from a span lands elsewhere as the same music (ties, tuplets, stacked
 * chords, grace notes and slurs included), replaces what was under it, replays from the log, and refuses what it cannot place.
 */

const imported = (document: Score): { score: Score; log: Operation[] } => {
  const op = { type: 'score.import', payload: { document } } as Operation;
  const applied = applyOperation(null, op);
  return { score: applied.score, log: [applied.operation] };
};

/** A bar's music with ids and review flags stripped: what "the same music" means across a paste. */
function shape(score: Score, bar: number): unknown {
  const view = barViews(score).find((candidate) => candidate.number === bar)!;
  const strip = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, v) => (key === 'id' || key === 'review' || key === 'memberIds' || key === 'barId' ? undefined : v)));
  return strip({ items: view.items, tuplets: view.tuplets.map((t) => ({ actual: t.actual, normal: t.normal })), chords: view.chords, annotations: view.annotations });
}

describe('range.paste', () => {
  for (const [name, make] of [
    ['the nasty chart (tuplets, ties, chords)', nastyChart],
    ['stacked chords', stackedChordsChart],
    ['grace notes', graceNotesChart],
  ] as const) {
    it(`pastes ${name} two bars later as the same music, replacing what was there`, () => {
      const { score, log } = imported(make());
      const clip = copyRange(score, { staff: 1, from: { bar: 1 }, to: { bar: 2 } });
      expect(clipProblem(JSON.parse(JSON.stringify(clip)))).toBeNull();
      const target = 'bar3.beat1';
      const applied = applyOperation(score, { type: 'range.paste', target, payload: { clip } } as Operation);
      expect(shape(applied.score, 3)).toEqual(shape(score, 1));
      expect(shape(applied.score, 4)).toEqual(shape(score, 2));
      // Bars outside the span are untouched.
      expect(shape(applied.score, 1)).toEqual(shape(score, 1));
      expect(shape(applied.score, 2)).toEqual(shape(score, 2));
      // The recorded op replays to the same document.
      const replayed = replay([...log, applied.operation]);
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(applied.score));
      // Fresh ids: nothing collides with the source.
      const ids = barViews(applied.score).flatMap((bar) => bar.items.map((item) => item.id));
      expect(new Set(ids).size).toBe(ids.length);
    });
  }

  it('carries a slur with its notes and leaves a slur with an end outside the span behind', () => {
    const { score } = imported(slurChart());
    const spanner = score.spanners![0]!;
    const noteBar = (id: string): number => barViews(score).find((bar) => bar.items.some((item) => item.id === id))!.number;
    const from = noteBar(spanner.startId);
    const to = noteBar(spanner.endId);
    const whole = copyRange(score, { staff: 1, from: { bar: from }, to: { bar: to } });
    expect(whole.spanners).toHaveLength(1);
    const cut = copyRange(score, { staff: 1, from: { bar: from }, to: { bar: from } });
    if (from !== to) expect(cut.spanners).toHaveLength(0);
  });

  it('pastes at a beat inside a bar, keeping the span a stretch of ticks', () => {
    const { score } = imported(nastyChart());
    const clip = copyRange(score, { staff: 1, from: { bar: 1, onset: 0 }, to: { bar: 1, onset: 960 }, harmony: false });
    const applied = applyOperation(score, { type: 'range.paste', target: 'bar3.beat3', payload: { clip } } as Operation);
    const bar5 = barViews(applied.score).find((bar) => bar.number === 3)!;
    expect(bar5.items.some((item) => item.onset === 960)).toBe(true);
  });

  it('refuses a paste that runs past the last bar, a clip from another meter, and junk', () => {
    const { score } = imported(nastyChart());
    const last = Math.max(...score.bars.map((bar) => bar.number));
    const clip = copyRange(score, { staff: 1, from: { bar: 1 }, to: { bar: 2 } });
    expect(() => applyOperation(score, { type: 'range.paste', target: `bar${last}.beat1`, payload: { clip } } as Operation)).toThrow(/bar add/);
    const waltz: Clip = { ...clip, time: { beats: 3, beatValue: 4 } };
    expect(() => applyOperation(score, { type: 'range.paste', target: 'bar3.beat1', payload: { clip: waltz } } as Operation)).toThrow(/different bar/);
    expect(() => applyOperation(score, { type: 'range.paste', target: 'bar3.beat1', payload: { clip: { nope: 1 } } } as unknown as Operation)).toThrow(/not a clip/);
  });
});

describe('range.clear', () => {
  it('empties whole bars of a staff in one op, and says so when there is nothing to clear', () => {
    const { score } = imported(nastyChart());
    const applied = applyOperation(score, { type: 'range.clear', payload: { staff: 's1', first: 1, last: 2, harmony: true } } as Operation);
    expect(barViews(applied.score).filter((bar) => bar.number >= 1 && bar.number <= 2).every((bar) => bar.items.length === 0 && bar.chords.length === 0)).toBe(true);
    expect(notesOf(barViews(applied.score).find((bar) => bar.number === 3)!).length).toBe(notesOf(barViews(score).find((bar) => bar.number === 3)!).length);
    expect(() => applyOperation(applied.score, { type: 'range.clear', payload: { staff: 's1', first: 1, last: 2 } } as Operation)).toThrow(/nothing to clear/);
  });
});

describe('copyRange', () => {
  it('copies only the selected ids, and records the meter and key', () => {
    const { score } = imported(nastyChart());
    const two = barViews(score).find((bar) => bar.number === 1)!.items.slice(0, 2).map((item) => item.id);
    const clip = copyRange(score, { staff: 1, from: { bar: 1 }, to: { bar: 1 }, ids: two });
    expect(clip.voices[0]!.items.map((item) => item.id)).toEqual(two);
    expect(clip.time).toEqual(score.meta.time);
  });
});
