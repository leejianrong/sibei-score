import type { Applier } from '../ops/applier.js';
import type { Owner, ScoreReader } from '../store/repository.js';
import type { Limits } from './limits.js';

/**
 * The applier, refusing a create the account has no room for (V23).
 *
 * A wrapper in the mould of `publishingApplier`: `applier.ts` stays the only consumer of a `ScoreWriter`
 * (ADR-0003), and the check cannot be forgotten by a new route because it sits on the capability, not on
 * the path. Only the three calls that bring a *new* score into being count: a create (an `apply` with no
 * score id), a duplicate, and an import. Edits, undo and redo add nothing.
 *
 * The job runner is deliberately *not* handed this wrapper. An import's quota is spent when it is
 * submitted (`spendImport`, plus a room check there), so refusing at landing would fail a job after the
 * worker had already done the work.
 */
export function quotaApplier(applier: Applier, reader: ScoreReader, limits: Limits): Applier {
  const room = async (owner: Owner): Promise<void> => {
    limits.checkScoreRoom((await reader.list(owner)).length);
  };
  return {
    ...applier,
    async apply(owner, scoreId, batch) {
      if (scoreId === null) await room(owner);
      return applier.apply(owner, scoreId, batch);
    },
    async duplicate(owner, scoreId, newId) {
      await room(owner);
      return applier.duplicate(owner, scoreId, newId);
    },
    async import(owner, document) {
      await room(owner);
      return applier.import(owner, document);
    },
  };
}
