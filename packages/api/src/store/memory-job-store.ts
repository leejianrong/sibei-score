import { randomUUID } from 'node:crypto';
import type { OmrDocument } from '@sibei/model';
import type { BlobKey } from '../blob/blob-store.js';
import type { Owner } from './repository.js';
import type { ImportJob, ImportJobSummary, JobId, JobStore } from './jobs.js';

/**
 * The job port over a `Map`. The `:memory:` of jobs (cf. `memory-blob-store.ts`).
 *
 * This is what `createApi` falls back to when no durable job store is supplied, and it is what the
 * fast-layer runner and state-machine tests run against — the contract is the port's, not the
 * medium's, so `tests/store/sqlite-job-store.test.ts` runs the same table against the SQLite
 * adapter. Everything the store hands out is a fresh copy: a caller that kept the object and mutated
 * it would otherwise be editing the queue, which no real implementation would allow.
 */
export interface MemoryJobStoreOptions {
  /** Injected so a test can assert on the timestamp rather than tolerate it. */
  now?: () => Date;
  /** Injected so a test gets deterministic ids. */
  newId?: () => JobId;
}

export function memoryJobStore(options: MemoryJobStoreOptions = {}): JobStore {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());
  const jobs = new Map<JobId, ImportJob>();

  const copy = (job: ImportJob): ImportJob => ({ ...job, imageKeys: [...job.imageKeys] });
  const stamp = (): string => `${now().toISOString().slice(0, 19)}Z`;

  return {
    list(owner: Owner) {
      return [...jobs.values()]
        .filter((job) => job.owner === owner)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .map(toSummary);
    },

    get(owner: Owner, id: JobId) {
      const job = jobs.get(id);
      return job !== undefined && job.owner === owner ? copy(job) : null;
    },

    create(owner: Owner, imageKeys: BlobKey[]) {
      if (imageKeys.length === 0) throw new Error('an import job must carry at least one image');
      const when = stamp();
      const job: ImportJob = {
        id: newId(),
        owner,
        status: 'queued',
        imageKeys: [...imageKeys],
        attempts: 0,
        diagnostic: null,
        result: null,
        scoreId: null,
        version: 1,
        createdAt: when,
        updatedAt: when,
      };
      jobs.set(job.id, job);
      return copy(job);
    },

    claim() {
      const next = [...jobs.values()]
        .filter((job) => job.status === 'queued')
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))[0];
      if (next === undefined) return null;
      next.status = 'running';
      next.attempts += 1;
      next.version += 1;
      next.updatedAt = stamp();
      return copy(next);
    },

    complete(id: JobId, result: OmrDocument[]) {
      const job = jobs.get(id);
      if (job === undefined || job.status !== 'running') return null;
      job.status = 'succeeded';
      job.result = result;
      job.diagnostic = null;
      job.version += 1;
      job.updatedAt = stamp();
      return copy(job);
    },

    fail(id: JobId, diagnostic: string) {
      const job = jobs.get(id);
      if (job === undefined || job.status !== 'running') return null;
      job.status = 'failed';
      job.diagnostic = diagnostic;
      job.version += 1;
      job.updatedAt = stamp();
      return copy(job);
    },

    retry(owner: Owner, id: JobId) {
      const job = jobs.get(id);
      if (job === undefined || job.owner !== owner || job.status !== 'failed') return null;
      job.status = 'queued';
      job.diagnostic = null;
      job.version += 1;
      job.updatedAt = stamp();
      return copy(job);
    },

    recover(diagnostic: string) {
      let recovered = 0;
      for (const job of jobs.values()) {
        if (job.status !== 'running') continue;
        job.status = 'failed';
        job.diagnostic = diagnostic;
        job.version += 1;
        job.updatedAt = stamp();
        recovered += 1;
      }
      return recovered;
    },

    close() {
      jobs.clear();
    },
  };
}

function toSummary(job: ImportJob): ImportJobSummary {
  const { result: _result, ...summary } = job;
  return { ...summary, imageKeys: [...summary.imageKeys] };
}
