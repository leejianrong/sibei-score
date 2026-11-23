import { describe, expect, it } from 'vitest';
import { applyOperation } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { FIXTURE_REGISTRY, pageSetupChart } from '@sibei/fixtures';
import { layout, pageInputFromMeta, resolvePageSpec } from '@sibei/layout';
import { projectScore } from '@sibei/model';
import type { Score } from '@sibei/model';
import { PAGE_FIELDS, pageFieldText, pageSetOp } from '../../packages/ui/src/lib/page-edits.js';

/** Page setup (SIB2-287): `meta.page` in millimetres through layout, the op, the projection and the browser's field edits. */

function run(operations: Operation[]): Score {
  let score: Score | null = null;
  for (const operation of operations) score = applyOperation(score, operation).score;
  return score!;
}
const create: Operation = { type: 'score.create', payload: { id: 'x', title: 'X', barCount: 8 } } as Operation;
const MM = 72 / 25.4;

describe('layout', () => {
  it('is exactly the default spec with no page setup', () => {
    expect(pageInputFromMeta(undefined)).toEqual({});
    expect(resolvePageSpec(pageInputFromMeta(undefined))).toEqual(resolvePageSpec());
  });

  it('a staff size sets the page scale, and margins and the gap keep their physical size', () => {
    const spec = resolvePageSpec(pageInputFromMeta({ staffSize: 6, margin: { left: 25 }, systemGap: 12 }));
    // The five-line staff is 40 units, so 6 mm of staff is 6 mm * MM points over 40 units.
    expect(spec.pointsPerUnit * spec.staffHeight).toBeCloseTo(6 * MM, 6);
    expect(spec.margin.left * spec.pointsPerUnit).toBeCloseTo(25 * MM, 6);
    expect(spec.systemGap * spec.pointsPerUnit).toBeCloseTo(12 * MM, 6);
    // What was not set keeps the layout's own value.
    expect(spec.margin.top).toBe(56);
  });

  it('a margin alone does not touch the staff size', () => {
    const spec = resolvePageSpec(pageInputFromMeta({ margin: { top: 30 } }));
    expect(spec.pointsPerUnit).toBe(resolvePageSpec().pointsPerUnit);
    expect(spec.margin.top * spec.pointsPerUnit).toBeCloseTo(30 * MM, 6);
  });

  it('the page setup fixture lays out smaller, narrower and with more room than the plain chart', () => {
    const chart = pageSetupChart();
    const { page: _page, ...meta } = chart.meta;
    const plain = layout({ ...chart, meta });
    const set = layout(chart);
    expect(set.pageSpec.pointsPerUnit).toBeLessThan(plain.pageSpec.pointsPerUnit);
    expect(set.pages[0]!.systems[0]!.x).toBeGreaterThan(plain.pages[0]!.systems[0]!.x * plain.pageSpec.pointsPerUnit / set.pageSpec.pointsPerUnit - 1);
    // Four bars to a line is still the grid: the page setup does not change what is on each line.
    expect(set.systemCount).toBe(plain.systemCount);
  });

  it('an explicit input still wins over the score', () => {
    const result = layout(pageSetupChart(), { pointsPerUnit: 0.7, margin: { left: 10 } });
    expect(result.pageSpec.pointsPerUnit).toBe(0.7);
    expect(result.pageSpec.margin.left).toBe(10);
    // The side the caller did not name still comes from the score (25 mm at 0.7 pt a unit).
    expect(result.pageSpec.margin.right * 0.7).toBeCloseTo(25 * MM, 6);
  });

  it('is registered as a fixture', () => {
    expect(FIXTURE_REGISTRY['page-setup']).toBe(pageSetupChart);
  });
});

describe('page.set', () => {
  it('sets fields, rounds to a tenth and clears with null; an empty page is no page at all', () => {
    const set = run([create, { type: 'page.set', payload: { staffSize: 7.04, marginLeft: 20, marginTop: 15 } }]);
    expect(set.meta.page).toEqual({ staffSize: 7, margin: { left: 20, top: 15 } });
    const some = run([create, { type: 'page.set', payload: { staffSize: 7, systemGap: 5 } }, { type: 'page.set', payload: { staffSize: null } }]);
    expect(some.meta.page).toEqual({ systemGap: 5 });
    const none = run([create, { type: 'page.set', payload: { staffSize: 7 } }, { type: 'page.set', payload: { staffSize: null } }]);
    expect('page' in none.meta).toBe(false);
  });

  it('refuses a value out of range, a non-number, an empty payload and an unknown field', () => {
    expect(() => run([create, { type: 'page.set', payload: { staffSize: 30 } }])).toThrow(/millimetres from 4 to 14/);
    expect(() => run([create, { type: 'page.set', payload: { marginTop: 'x' as unknown as number } }])).toThrow(/millimetres/);
    expect(() => run([create, { type: 'page.set', payload: {} }])).toThrow(/at least one/);
  });

  it('shows in the text projection only when set', () => {
    expect(projectScore(run([create]))).not.toContain('page:');
    expect(projectScore(pageSetupChart())).toContain('page: staff 6mm, margins top 20 right 25 left 25mm, system gap 12mm');
  });
});

describe('the browser panel edits', () => {
  const score = pageSetupChart();

  it('shows what is set and blank for the default', () => {
    expect(pageFieldText(score, 'staffSize')).toBe('6');
    expect(pageFieldText(score, 'marginLeft')).toBe('25');
    expect(pageFieldText(score, 'marginBottom')).toBe('');
    expect(PAGE_FIELDS).toHaveLength(6);
  });

  it('sends only a change, clears on blank and refuses what is not a number in range', () => {
    expect(pageSetOp(score, 'staffSize', '6')).toEqual({ ok: true, error: null, op: null });
    expect(pageSetOp(score, 'staffSize', ' 7.5 ').op).toEqual({ type: 'page.set', payload: { staffSize: 7.5 } });
    expect(pageSetOp(score, 'staffSize', '').op).toEqual({ type: 'page.set', payload: { staffSize: null } });
    expect(pageSetOp(score, 'marginTop', 'wide').ok).toBe(false);
    expect(pageSetOp(score, 'marginTop', '99').error).toMatch(/3 to 60 mm/);
  });
});
