import { describe, expect, it } from 'vitest';
import { applyOperation, replay, OperationError } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { longFormChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import { projectScore } from '@sibei/model';
import type { Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';
import { renderScorePages } from '@sibei/ui';

/** `meta set --signature-policy` (SIB2-173): where the clef and key signature are drawn. */

const withPolicy = (policy: 'every' | 'first' | 'page'): Score => ({
  ...longFormChart(),
  meta: { ...longFormChart().meta, ...(policy === 'every' ? {} : { signaturePolicy: policy }) },
});

function heads(score: Score) {
  return layout(score).pages.flatMap((page) =>
    page.systems.map((system, at) => {
      const head = system.bars[0]!;
      return {
        page: page.index,
        at,
        clef: head.items.some((i) => i.kind === 'clef'),
        key: head.items.some((i) => i.kind === 'keySignature'),
        width: head.prefixWidth,
        number: head.items.some((i) => i.kind === 'barNumber'),
      };
    }),
  );
}

describe('the signature policy in layout', () => {
  it('every system is the default, and an absent policy is the same as `every`', () => {
    expect(heads(withPolicy('every')).every((h) => h.clef && h.key)).toBe(true);
    expect(renderScoreToSvg(withPolicy('every'))).toEqual(renderScoreToSvg(longFormChart()));
  });

  it('first puts them on the first system only, keeps bar numbers, and gives later bars the room', () => {
    const all = heads(withPolicy('first'));
    expect(all[0]).toMatchObject({ clef: true, key: true });
    for (const h of all.slice(1)) {
      expect(h).toMatchObject({ clef: false, key: false });
      expect(h.width).toBeLessThan(layout(withPolicy('every')).pages[0]!.systems[1]!.bars[0]!.prefixWidth);
    }
    expect(all.slice(1).every((h) => h.number)).toBe(true);

    const everyWidths = layout(withPolicy('every')).pages[0]!.systems[1]!.bars.map((b) => b.width);
    const firstWidths = layout(withPolicy('first')).pages[0]!.systems[1]!.bars.map((b) => b.width);
    expect(firstWidths[0]).toBeLessThan(everyWidths[0]!);
    expect(firstWidths.reduce((a, b) => a + b)).toBeCloseTo(everyWidths.reduce((a, b) => a + b));
  });

  it('page puts them on the first system of each page', () => {
    const all = heads(withPolicy('page'));
    expect(Math.max(...all.map((h) => h.page))).toBeGreaterThan(0);
    for (const h of all) expect(h.clef && h.key).toBe(h.at === 0);
  });

  it('draws the same bytes in the browser and on the server', () => {
    for (const policy of ['first', 'page'] as const) {
      const score = withPolicy(policy);
      expect(renderScorePages(score).map((p) => p.svg)).toEqual(renderScoreToSvg(score).map((p) => p.svg));
    }
  });
});

describe('meta.set signaturePolicy', () => {
  const create: Operation = { type: 'score.create', payload: { id: 'c', barCount: 4 } };
  const set = (signaturePolicy: string): Operation => ({ type: 'meta.set', payload: { signaturePolicy } }) as Operation;

  it('sets it, stores `every` as absent, replays, and shows in the projection', () => {
    let score = applyOperation(null, create).score;
    const log: Operation[] = [create];
    for (const op of [set('first'), set('page')]) {
      const applied = applyOperation(score, op);
      score = applied.score;
      log.push(applied.operation);
    }
    expect(score.meta.signaturePolicy).toBe('page');
    expect(replay(log)).toEqual(score);
    expect(projectScore(score)).toContain('clef and key: first system of each page');

    const back = applyOperation(score, set('every')).score;
    expect(Object.keys(back.meta)).not.toContain('signaturePolicy');
    expect(projectScore(back)).not.toContain('clef and key');
  });

  it('refuses a policy it does not know', () => {
    const score = applyOperation(null, create).score;
    expect(() => applyOperation(score, set('never'))).toThrow(OperationError);
  });

  it('keeps the policy through other meta edits', () => {
    const score = applyOperation(applyOperation(null, create).score, set('first')).score;
    const next = applyOperation(score, { type: 'meta.set', payload: { title: 'X' } }).score;
    expect(next.meta.signaturePolicy).toBe('first');
  });
});
