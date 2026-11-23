import { describe, expect, it } from 'vitest';
import { applyOperation, replay } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { dynamicsChart, dynamicsStavesChart } from '@sibei/fixtures';
import { DYNAMICS_ASCENT, DYNAMICS_DESCENT, DYNAMICS_GAP, layout } from '@sibei/layout';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { DYNAMICS, barViews, dur, orderedItems, projectScore } from '@sibei/model';
import type { Dynamic, Score } from '@sibei/model';
import { hairpinOp, hairpinsOnNote, removeHairpinOp } from '../../packages/ui/src/lib/slur-edits.js';

/** Dynamics and hairpins (SIB2-274, ADR-0021 amendment): ops, projection, layout. */

function run(operations: Operation[]): { score: Score; log: Operation[] } {
  const log: Operation[] = [];
  let score: Score | null = null;
  for (const operation of operations) {
    const applied = applyOperation(score, operation);
    score = applied.score;
    log.push(applied.operation);
  }
  if (score === null) throw new Error('no score');
  return { score, log };
}

const q = dur(4);
const base: Operation[] = [
  { type: 'score.create', payload: { id: 'chart', barCount: 2 } },
  { type: 'note.add', target: 'bar1.beat1', payload: { pitch: 'C5', duration: q } },
  { type: 'note.add', target: 'bar1.beat2', payload: { pitch: 'D5', duration: q } },
  { type: 'rest.add', target: 'bar1.beat3', payload: { duration: q } },
  { type: 'note.add', target: 'bar1.beat4', payload: { pitch: 'E5', duration: q } },
];
const dyn = (target: string, value: Dynamic): Operation => ({ type: 'dynamic.set', target, payload: { value } });
const hairpin = (from: string, to: string, shape: 'crescendo' | 'diminuendo'): Operation => ({
  type: 'hairpin.set',
  target: from,
  payload: { to, shape },
});

describe('dynamic.set and dynamic.rm', () => {
  it('marks a note and a rest, replaces a marking, replays, and leaves no field behind when removed', () => {
    const on = run([...base, dyn('bar1.n1', 'mf'), dyn('bar1.n3', 'p'), dyn('bar1.n1', 'ff')]);
    expect(barViews(on.score)[0]!.items.map((item) => item.dynamic)).toEqual(['ff', undefined, 'p', undefined]);
    expect(replay(on.log)).toEqual(on.score);
    const off = run([...on.log, { type: 'dynamic.rm', target: 'bar1.n1' }]);
    expect('dynamic' in barViews(off.score)[0]!.items[0]!).toBe(false);
  });

  it('accepts exactly the closed set and refuses the rest', () => {
    for (const value of DYNAMICS) expect(() => run([...base, dyn('bar1.n1', value)])).not.toThrow();
    expect(() => run([...base, dyn('bar1.n1', 'mezzo' as Dynamic)])).toThrow(/a dynamic is one of/);
    expect(() => run([...base, { type: 'dynamic.rm', target: 'bar1.n1' }])).toThrow(/nothing to remove/);
  });

  it('a chart without dynamics has no dynamic field and layout reserves no row', () => {
    const { score } = run(base);
    expect(JSON.stringify(score)).not.toContain('dynamic');
    const system = layout(score).pages[0]!.systems[0]!;
    expect(system.dynamicsOffset).toBeUndefined();
    expect(system.hairpins).toBeUndefined();
  });
});

describe('hairpin.set and hairpin.rm', () => {
  it('sets a wedge between two notes, upserts the shape, removes by id or by start note', () => {
    const one = run([...base, hairpin('bar1.n1', 'bar1.n4', 'crescendo')]);
    expect(one.score.spanners).toEqual([
      expect.objectContaining({ kind: 'hairpin', hairpin: 'crescendo', id: 'hairpin-1' }),
    ]);
    const flipped = run([...one.log, hairpin('bar1.n1', 'bar1.n4', 'diminuendo')]);
    expect(flipped.score.spanners).toHaveLength(1);
    expect(flipped.score.spanners![0]!.hairpin).toBe('diminuendo');
    expect(replay(flipped.log)).toEqual(flipped.score);
    expect(run([...one.log, { type: 'hairpin.rm', target: 'hairpin-1' }]).score.spanners).toBeUndefined();
    expect(run([...one.log, { type: 'hairpin.rm', target: 'bar1.n1' }]).score.spanners).toBeUndefined();
  });

  it('refuses a reversed run, a rest as an end, an unknown shape and an overlap', () => {
    expect(() => run([...base, hairpin('bar1.n4', 'bar1.n1', 'crescendo')])).toThrow(/to a later one/);
    expect(() => run([...base, hairpin('bar1.n1', 'bar1.n3', 'crescendo')])).toThrow();
    expect(() => run([...base, hairpin('bar1.n1', 'bar1.n4', 'loud' as 'crescendo')])).toThrow(/shape/);
    expect(() => run([...base, hairpin('bar1.n1', 'bar1.n4', 'crescendo'), hairpin('bar1.n2', 'bar1.n4', 'diminuendo')])).toThrow(/does not overlap|do not overlap/);
  });

  it('is removed with the note it ends on', () => {
    const { score } = run([...base, hairpin('bar1.n1', 'bar1.n4', 'crescendo'), { type: 'note.rm', target: 'bar1.n4' }]);
    expect(score.spanners ?? []).toHaveLength(0);
  });
});

describe('the projection', () => {
  it('prints @mf after a mark, and the hairpin with the addresses its verb takes', () => {
    const { score } = run([...base, dyn('bar1.n1', 'mf'), hairpin('bar1.n2', 'bar1.n4', 'diminuendo')]);
    const text = projectScore(score);
    expect(text).toContain('c5/4@mf');
    expect(text).toContain('hairpin  bar1.n2 -> bar1.n4 dim hairpin-1');
  });
});

/** Dynamics by reading-order item, and hairpins by the ordinal of their ends: ids are the file's, not ours. */
function marks(score: Score): unknown {
  const order = new Map<string, string>();
  for (const bar of barViews(score)) {
    orderedItems(bar).forEach((item, at) => order.set(item.id, `bar${bar.number}.n${at + 1}`));
  }
  return {
    dynamics: barViews(score).flatMap((bar) =>
      orderedItems(bar).flatMap((item, at) => (item.dynamic === undefined ? [] : [`bar${bar.number}.n${at + 1}=${item.dynamic}`])),
    ),
    hairpins: (score.spanners ?? [])
      .filter((spanner) => spanner.kind === 'hairpin')
      .map((spanner) => `${order.get(spanner.startId)}->${order.get(spanner.endId)} ${spanner.hairpin}`),
  };
}

describe('the browser controls', () => {
  it('builds the op for two notes in either order, lists the wedges over a note, and removes one by id', () => {
    const { score } = run(base);
    const ids = barViews(score)[0]!.items.map((item) => item.id);
    const forward = hairpinOp(score, ids[0]!, ids[3]!, 'crescendo');
    expect(forward).toEqual({ type: 'hairpin.set', target: ids[0], payload: { to: ids[3], shape: 'crescendo' } });
    expect(hairpinOp(score, ids[3]!, ids[0]!, 'crescendo')).toEqual(forward);
    expect(hairpinOp(score, ids[0]!, ids[0]!, 'crescendo')).toBeNull();
    const set = run([...base, hairpin('bar1.n1', 'bar1.n4', 'diminuendo')]).score;
    expect(hairpinsOnNote(set, ids[1]!)).toHaveLength(1);
    expect(hairpinsOnNote(set, ids[0]!).map((line) => line.id)).toEqual(['hairpin-1']);
    expect(removeHairpinOp('hairpin-1')).toEqual({ type: 'hairpin.rm', target: 'hairpin-1' });
  });
});

describe('MusicXML', () => {
  it('round trips every marking and every wedge of the dynamics chart, with no warning', () => {
    const original = dynamicsChart();
    const xml = scoreToMusicXml(original);
    expect(xml).toMatch(/<dynamics>\s*<mf\/>\s*<\/dynamics>/);
    expect(xml).toContain('<wedge type="crescendo"');
    const { score, warnings } = musicXmlToScore(xml, { id: original.id });
    expect(warnings).toEqual([]);
    expect(marks(score)).toEqual(marks(original));
    expect((marks(original) as { dynamics: string[] }).dynamics.length).toBeGreaterThan(10);
  });

  it('keeps each staff of a grand staff its own markings', () => {
    const original = dynamicsStavesChart();
    const { score, warnings } = musicXmlToScore(scoreToMusicXml(original), { id: original.id });
    expect(warnings).toEqual([]);
    expect((score.spanners ?? []).filter((spanner) => spanner.kind === 'hairpin').map((spanner) => spanner.hairpin)).toEqual([
      'crescendo',
      'diminuendo',
    ]);
  });

  it('names a dynamic outside the closed set instead of dropping it silently', () => {
    const xml = scoreToMusicXml(dynamicsChart()).replace('<mf/>', '<fz/>');
    const { warnings } = musicXmlToScore(xml, { id: 'x' });
    expect(warnings.some((warning) => warning.includes('<fz>'))).toBe(true);
  });
});

describe('layout', () => {
  it('reserves the row only under a system that has a mark, and by the shared constants', () => {
    const result = layout(dynamicsChart());
    for (const system of result.pages[0]!.systems) {
      expect(system.dynamicsOffset).toBeDefined();
      expect(system.belowStaff).toBeGreaterThanOrEqual(system.dynamicsOffset! + DYNAMICS_DESCENT);
    }
    expect(DYNAMICS_GAP + DYNAMICS_ASCENT).toBeGreaterThan(0);
  });

  it('splits a hairpin that crosses the system break into two halves', () => {
    const systems = layout(dynamicsChart()).pages[0]!.systems;
    const halves = systems.flatMap((system) => system.hairpins ?? []).filter((line) => line.id === 'hairpin-3');
    expect(halves).toHaveLength(2);
    expect(halves[0]!.toNoteId).toBeNull();
    expect(halves[1]!.fromNoteId).toBeNull();
  });

  it('gives each staff of a grand staff its own row', () => {
    const system = layout(dynamicsStavesChart()).pages[0]!.systems[0]!;
    expect(system.staves!.map((staff) => staff.dynamicsOffset !== undefined)).toEqual([true, true]);
    expect((system.hairpins ?? []).map((line) => line.staff ?? 0).sort()).toEqual([0, 1]);
  });
});
