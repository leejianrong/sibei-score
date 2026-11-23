import { barViews } from '@sibei/model';
import type { BarView, Id, Score } from '@sibei/model';
import { OperationError } from './errors.js';
import type { Operation } from './operations.js';

/**
 * Size caps on a *new write* (SEC H1). Without them one account can send a 1 MB batch of
 * `bar.add count:1000` ops and make the single Node process do quadratic work in `shiftBars`.
 *
 * They are enforced in `createApplier.apply` only — never in replay and never for `score.import`
 * (duplicate, OMR landing): ADR-0028 says an old log must keep replaying whatever the rules are today,
 * and an import is bounded by what a recogniser can read off an uploaded page, not by a client's JSON.
 * A refusal is the existing `validation` error, naming the limit.
 *
 * The ops-per-batch and bars checks run *before* folding, so a refused batch costs O(ops), not O(work).
 */
export interface WriteCaps {
  maxOpsPerBatch: number;
  maxBarsPerScore: number;
  /** Notes + rests + chords + annotations on one bar. */
  maxItemsPerBar: number;
  /**
   * Scores one owner may hold, enforced atomically inside the store's create (SEC H2). Set by the server
   * from the account quota; absent means no ceiling (a local install).
   */
  maxScores?: number;
}

export const DEFAULT_WRITE_CAPS: WriteCaps = { maxOpsPerBatch: 500, maxBarsPerScore: 2000, maxItemsPerBar: 500 };

/** `SBSCORE_CAP_OPS_PER_BATCH`, `SBSCORE_CAP_BARS_PER_SCORE`, `SBSCORE_CAP_ITEMS_PER_BAR`. */
export function writeCapsFromEnv(env: Record<string, string | undefined>): WriteCaps {
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive whole number, got ${JSON.stringify(raw)}`);
    return value;
  };
  return {
    maxOpsPerBatch: read('SBSCORE_CAP_OPS_PER_BATCH', DEFAULT_WRITE_CAPS.maxOpsPerBatch),
    maxBarsPerScore: read('SBSCORE_CAP_BARS_PER_SCORE', DEFAULT_WRITE_CAPS.maxBarsPerScore),
    maxItemsPerBar: read('SBSCORE_CAP_ITEMS_PER_BAR', DEFAULT_WRITE_CAPS.maxItemsPerBar),
  };
}

const refuse = (detail: string): never => {
  throw new OperationError({ kind: 'validation', detail });
};

/** Before any op is folded: the batch length, and an upper bound on the bars it could leave behind. */
export function checkBeforeFold(caps: WriteCaps, operations: readonly Operation[], currentBars: number): void {
  if (operations.length > caps.maxOpsPerBatch) {
    refuse(`a batch is capped at ${caps.maxOpsPerBatch} operations, got ${operations.length}`);
  }
  let bars = currentBars;
  for (const operation of operations) {
    // Read defensively: an ill-typed count is the applier's own validation error to give.
    if (operation.type === 'bar.add') {
      const count = operation.payload?.count;
      bars += typeof count === 'number' && count > 0 ? Math.min(count, 1_000_000) : 1;
    } else if (operation.type === 'score.create') {
      const count = operation.payload?.barCount;
      if (typeof count === 'number' && count > 0) bars = Math.max(bars, Math.min(count, 1_000_000));
    }
    if (bars > caps.maxBarsPerScore) {
      refuse(`a score is capped at ${caps.maxBarsPerScore} bars`);
    }
  }
}

/**
 * After the fold: a bar may not grow past the item cap. Only a bar the batch *grew* is refused, so an
 * existing document already over the cap stays editable.
 */
export function checkAfterFold(caps: WriteCaps, before: Score | null, after: Score): void {
  const prior = new Map<Id, number>();
  for (const bar of before === null ? [] : barViews(before)) prior.set(bar.id, size(bar));
  for (const bar of barViews(after)) {
    const now = size(bar);
    if (now > caps.maxItemsPerBar && now > (prior.get(bar.id) ?? 0)) {
      refuse(`a bar is capped at ${caps.maxItemsPerBar} items (notes, rests, chords and annotations), bar ${bar.number} would have ${now}`);
    }
  }
}

function size(bar: BarView): number {
  return bar.items.length + bar.chords.length + bar.annotations.length;
}
