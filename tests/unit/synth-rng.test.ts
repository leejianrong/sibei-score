import { makeRng } from '@sibei/synth';
import { describe, expect, it } from 'vitest';

/**
 * The seeded PRNG is the determinism spine of the whole synth package (ADR-0031): a seed in, the
 * same corpus out, so two eval runs are comparable. These tests hold it to exactly that.
 */

describe('makeRng', () => {
  it('produces the same stream for the same seed', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    const drawA = Array.from({ length: 20 }, () => a.next());
    const drawB = Array.from({ length: 20 }, () => b.next());
    expect(drawA).toEqual(drawB);
  });

  it('produces different streams for different seeds', () => {
    const a = Array.from({ length: 20 }, () => makeRng(1).next());
    const b = Array.from({ length: 20 }, () => makeRng(2).next());
    expect(a).not.toEqual(b);
  });

  it('draws floats in [0, 1)', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('int is inclusive on both ends and never out of range', () => {
    const rng = makeRng(99);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i += 1) {
      const value = rng.int(3, 6);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(6);
      seen.add(value);
    }
    expect(seen).toEqual(new Set([3, 4, 5, 6]));
  });

  it('pick throws on an empty array and otherwise returns a member', () => {
    const rng = makeRng(5);
    expect(() => rng.pick([])).toThrow();
    const items = ['a', 'b', 'c'];
    for (let i = 0; i < 100; i += 1) expect(items).toContain(rng.pick(items));
  });

  it('weighted respects weights and rejects a mismatched length', () => {
    const rng = makeRng(11);
    expect(() => rng.weighted(['x', 'y'], [1])).toThrow();
    // A weight of 0 means never chosen.
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 500; i += 1) counts[rng.weighted(['a', 'b'], [1, 0]) as 'a' | 'b'] += 1;
    expect(counts).toEqual({ a: 500, b: 0 });
  });
});
