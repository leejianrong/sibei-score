import type { BlobKey } from '../blob/blob-store.js';
import type { Owner } from './repository.js';
import { timestamp } from './store-shared.js';

/**
 * The blob ledger (V25, ADR-0034 decisions 11 and 16): a durable record of *which account owns which
 * stored blob*.
 *
 * It exists because a blob key is hashed into a filename or an object name by every `BlobStore`, so the
 * store cannot be asked "what does this account hold?" and could not be swept or emptied by owner without
 * the answer being kept somewhere else. Everything that writes a blob on an account's behalf records it
 * here (import scans, the export cache, and the audio objects a later slice adds); account deletion lists
 * the account's rows and deletes each blob, and the sweep finds expired or orphaned ones by kind and age.
 *
 * Owner-scoped like every other port: a row is `(owner, key)`, so two accounts that hold the "same" key
 * each have their own row. Recording is an idempotent upsert, and the first record wins the timestamp.
 */
export interface BlobRef {
  owner: Owner;
  key: BlobKey;
  /** What the blob is, so a sweep can apply a different lifetime to each: `import-source`, `export`, … */
  kind: string;
  /** ISO timestamp of the first time it was recorded. */
  recordedAt: string;
}

export interface BlobLedger {
  record(owner: Owner, key: BlobKey, kind: string): Promise<void>;
  /** Every blob this owner holds, oldest first. */
  list(owner: Owner): Promise<BlobRef[]>;
  /** Forget one blob (after it was deleted). Forgetting what is not there is not an error. */
  forget(owner: Owner, key: BlobKey): Promise<void>;
  /** Forget everything this owner holds. */
  forgetAll(owner: Owner): Promise<void>;
  /**
   * Blobs of a kind recorded before `before`, across owners, oldest first, at most `limit`. The sweep's
   * query: a system actor, never reachable from a request.
   */
  olderThan(kind: string, before: string, limit: number): Promise<BlobRef[]>;
  close(): Promise<void>;
}

/** The in-process ledger: the default when no database is named, and what a test of the callers uses. */
export function memoryBlobLedger(now: () => Date = () => new Date()): BlobLedger {
  const refs = new Map<string, BlobRef>();
  const id = (owner: Owner, key: BlobKey): string => `${owner}\u0000${key}`;
  return {
    async record(owner, key, kind) {
      if (!refs.has(id(owner, key))) refs.set(id(owner, key), { owner, key, kind, recordedAt: timestamp(now) });
    },
    async list(owner) {
      return [...refs.values()].filter((ref) => ref.owner === owner).sort(byAge);
    },
    async forget(owner, key) {
      refs.delete(id(owner, key));
    },
    async forgetAll(owner) {
      for (const [k, ref] of refs) if (ref.owner === owner) refs.delete(k);
    },
    async olderThan(kind, before, limit) {
      return [...refs.values()].filter((ref) => ref.kind === kind && ref.recordedAt < before).sort(byAge).slice(0, limit);
    },
    async close() {},
  };
}

const byAge = (a: BlobRef, b: BlobRef): number => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0);
