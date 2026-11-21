import type { BlobStore, ManagedBlobStore } from '../blob/blob-store.js';
import type { BlobLedger } from '../store/blob-ledger.js';
import type { AudioJobStore } from '../store/audio-jobs.js';
import type { JobStore } from '../store/jobs.js';
import type { Owner, ScoreLibrary } from '../store/repository.js';

/**
 * Erase everything an account owns *except the account itself* (V25, ADR-0034 decisions 11 and 16): its
 * scores and op logs, its jobs, and every blob it holds, found through the blob ledger and through the
 * source-image keys its jobs carry (a job written before the ledger existed has no ledger row, so both
 * are unioned).
 *
 * **Order is the failure story.** The ledger rows go last, so a crash or a store outage part-way leaves
 * the ledger still naming what is left; the identity row is deleted by the caller only after this
 * returns, so the person can sign in and press the button again. Every step is idempotent (deleting what
 * is gone is not an error). The one residual is a *running* import that lands a score after its job row
 * was deleted: an orphan owned by an account that no longer exists, which nothing can reach and the owner
 * sweep removes.
 *
 * The blob store must be able to delete (a `ManagedBlobStore`; all three shipped stores are). Given one
 * that cannot, this refuses rather than report a deletion it did not perform.
 */
export interface OwnerEraser {
  erase(owner: Owner): Promise<{ scores: number; jobs: number; blobs: number }>;
}

export interface OwnerEraserOptions {
  library: ScoreLibrary;
  jobs: Pick<JobStore, 'deleteAll' | 'list'>;
  /** Audio jobs and their uploaded audio (ADR-0034 decisions 11 and 16). */
  audio: Pick<AudioJobStore, 'deleteAll'>;
  blobs: BlobStore;
  ledger: BlobLedger;
}

export function isManaged(store: BlobStore): store is ManagedBlobStore {
  return typeof (store as Partial<ManagedBlobStore>).delete === 'function';
}

export function createOwnerEraser(options: OwnerEraserOptions): OwnerEraser {
  const { library, jobs, audio, blobs, ledger } = options;
  return {
    async erase(owner) {
      if (!isManaged(blobs)) throw new Error('account deletion needs a blob store that can delete');

      const held = await ledger.list(owner);
      const jobCount = (await jobs.list(owner)).length;
      const sourceKeys = await jobs.deleteAll(owner);
      const audioKeys = await audio.deleteAll(owner);
      const scores = await library.deleteAll(owner);

      const keys = new Set([...held.map((ref) => ref.key), ...sourceKeys, ...audioKeys]);
      for (const key of keys) await blobs.delete(key);
      await ledger.forgetAll(owner);
      return { scores, jobs: jobCount, blobs: keys.size };
    },
  };
}
