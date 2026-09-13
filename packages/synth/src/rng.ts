/**
 * A seeded, deterministic pseudo-random generator. The determinism spine of the whole
 * package: the same seed produces the same corpus, so two eval runs are comparable and a
 * regression is a real change, not noise (ADR-0020's "seeded and deterministic", and
 * ADR-0031's "seeded, deterministic … a seed in, the same corpus out").
 *
 * Framework-free, Node-free plain TypeScript. `mulberry32` is used rather than
 * `Math.random` for exactly one reason: `Math.random` cannot be seeded, so it could not
 * give a reproducible corpus. This is a small, well-known 32-bit generator — good enough
 * to spread parameters, and not pretending to be cryptographic.
 */

export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], inclusive on both ends. */
  int(min: number, max: number): number;
  /** A float in [min, max). */
  float(min: number, max: number): number;
  /** true with probability p (default 0.5). */
  bool(p?: number): boolean;
  /** A uniformly chosen element. Throws on an empty array, which is always a caller bug. */
  pick<T>(items: readonly T[]): T;
  /** A weighted choice: `items[i]` chosen with probability `weights[i] / sum(weights)`. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
}

/**
 * mulberry32 (Tommy Ettinger, public domain). One 32-bit state word, advanced per draw.
 * A given seed always yields the same stream.
 */
export function makeRng(seed: number): Rng {
  // Coerce to a 32-bit unsigned integer so a float or a negative seed still behaves.
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => {
    if (max < min) throw new Error(`int: max ${max} < min ${min}`);
    return min + Math.floor(next() * (max - min + 1));
  };

  const float = (min: number, max: number): number => min + next() * (max - min);

  const bool = (p = 0.5): boolean => next() < p;

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error('pick: empty array');
    // items.length >= 1, so the index is in range and the element is defined.
    return items[int(0, items.length - 1)] as T;
  };

  const weighted = <T>(items: readonly T[], weights: readonly number[]): T => {
    if (items.length === 0) throw new Error('weighted: empty array');
    if (items.length !== weights.length) {
      throw new Error(`weighted: ${items.length} items but ${weights.length} weights`);
    }
    let total = 0;
    for (const w of weights) {
      if (w < 0) throw new Error(`weighted: negative weight ${w}`);
      total += w;
    }
    if (total <= 0) throw new Error('weighted: weights sum to zero');
    let roll = next() * total;
    for (let i = 0; i < items.length; i += 1) {
      roll -= weights[i] as number;
      if (roll < 0) return items[i] as T;
    }
    // Floating-point slack can leave roll >= 0 on the last step; the last item is the answer.
    return items[items.length - 1] as T;
  };

  return { next, int, float, bool, pick, weighted };
}
