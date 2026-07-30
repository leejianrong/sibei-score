import type { Id } from './score.js';

/**
 * Stable IDs are app-owned and readable: `note-17`, `bar-3`, `chord-9` (ADR-0007).
 * A factory rather than a global counter, so a render or a test is deterministic.
 */

export type IdPrefix = 'score' | 'bar' | 'note' | 'rest' | 'chord' | 'tuplet' | 'section' | 'annotation';

export interface IdFactory {
  next(prefix: IdPrefix): Id;
}

export function createIdFactory(): IdFactory {
  const counters = new Map<IdPrefix, number>();
  return {
    next(prefix) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}-${n}`;
    },
  };
}

const ID_PATTERN = /^([a-z]+)-(\d+)$/;

export function parseId(id: Id): { prefix: string; ordinal: number } | null {
  const match = ID_PATTERN.exec(id);
  if (match === null) return null;
  const [, prefix, digits] = match;
  if (prefix === undefined || digits === undefined) return null;
  return { prefix, ordinal: Number(digits) };
}
