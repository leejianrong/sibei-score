import type { BlobStore } from '../blob/blob-store.js';
import type { BlobLedger } from '../store/blob-ledger.js';
import { isManaged } from './erase.js';

/**
 * The blob sweep (V25b, ADR-0034 decisions 11 and 16, and the blob eviction KAN-516 asked for): delete blobs
 * that have outlived what they are for, found through the blob ledger by kind and age.
 *
 *   - `export` (the render cache): derived and re-creatable, so it only needs a lifetime, else superseded
 *     artefacts accumulate forever (Q81 chose "no invalidation logic" and named this housekeeping).
 *   - `audio`: copyright-sensitive, deleted when its job ends and in any case within 24 hours of upload
 *     (decision 16). The job's own completion path does the prompt delete; this is the backstop.
 *
 * Import scans are deliberately **not** swept: they live as long as the job that carries them (re-parse and
 * the source pane need them), and account deletion removes them.
 *
 * A pass deletes the blob first and forgets the ledger row after, so a failure leaves the row for the next
 * pass and nothing is ever forgotten that was not deleted. Every lifetime is configuration.
 */
export interface SweepLifetimes {
  /** Milliseconds a kind may live after it was first recorded. A kind not named here is never swept. */
  [kind: string]: number;
}

export const DEFAULT_SWEEP_LIFETIMES: SweepLifetimes = {
  export: 7 * 24 * 60 * 60 * 1000,
  audio: 24 * 60 * 60 * 1000,
};

export interface BlobSweeperOptions {
  ledger: BlobLedger;
  blobs: BlobStore;
  lifetimes?: SweepLifetimes;
  /** The most blobs one kind loses per pass, so a huge backlog is worked off in bounded steps. */
  batch?: number;
  now?: () => Date;
  onError?: (message: string, error: unknown) => void;
}

export interface BlobSweeper {
  /** One pass. Returns how many blobs it deleted, by kind. */
  sweepOnce(): Promise<Record<string, number>>;
  /** Run a pass now and then every `everyMs`. Returns the stop function. */
  start(everyMs: number): () => void;
}

export function createBlobSweeper(options: BlobSweeperOptions): BlobSweeper {
  const { ledger, blobs } = options;
  const lifetimes = options.lifetimes ?? DEFAULT_SWEEP_LIFETIMES;
  const batch = options.batch ?? 500;
  const now = options.now ?? (() => new Date());

  async function sweepOnce(): Promise<Record<string, number>> {
    const deleted: Record<string, number> = {};
    if (!isManaged(blobs)) return deleted;
    for (const [kind, lifetime] of Object.entries(lifetimes)) {
      const cutoff = new Date(now().getTime() - lifetime).toISOString().replace(/\.\d{3}Z$/, 'Z');
      deleted[kind] = 0;
      for (const ref of await ledger.olderThan(kind, cutoff, batch)) {
        await blobs.delete(ref.key);
        await ledger.forget(ref.owner, ref.key);
        deleted[kind] += 1;
      }
    }
    return deleted;
  }

  return {
    sweepOnce,
    start(everyMs) {
      const run = (): void => {
        sweepOnce().catch((error: unknown) => options.onError?.('the blob sweep failed', error));
      };
      run();
      const timer = setInterval(run, everyMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
