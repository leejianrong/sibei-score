import { randomUUID } from 'node:crypto';
import type { AudioJob, AudioJobId, AudioJobStore, AudioJobSummary } from './audio-jobs.js';

/**
 * The audio-job port over a `Map` — what `createApi` falls back to when no store is given, and what
 * the unit tests build the service on. The sibling of `memoryJobStore`; the conformance suite runs
 * against it as well as the two databases, so it is the same contract and not a lookalike.
 */
export interface MemoryAudioJobStoreOptions {
  now?: () => Date;
  newId?: () => AudioJobId;
}

export function memoryAudioJobStore(options: MemoryAudioJobStoreOptions = {}): AudioJobStore {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());
  const jobs = new Map<AudioJobId, AudioJob>();
  const stamp = () => `${now().toISOString().slice(0, 19)}Z`;

  const mine = (owner: string, id: AudioJobId): AudioJob | undefined => {
    const job = jobs.get(id);
    return job !== undefined && job.owner === owner ? job : undefined;
  };
  const update = (job: AudioJob, patch: Partial<AudioJob>): AudioJob => {
    const next = { ...job, ...patch, version: job.version + 1, updatedAt: stamp() };
    jobs.set(job.id, next);
    return structuredClone(next);
  };

  return {
    async list(owner) {
      return [...jobs.values()]
        .filter((job) => job.owner === owner)
        .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? 1 : -1))
        .map(({ result: _result, leaseToken: _leaseToken, ...summary }): AudioJobSummary => structuredClone(summary));
    },
    async get(owner, id) {
      const job = mine(owner, id);
      return job === undefined ? null : structuredClone(job);
    },
    async create(owner, job) {
      const at = stamp();
      const created: AudioJob = {
        id: newId(),
        owner,
        status: 'awaiting-upload',
        ...job,
        attempts: 0,
        diagnosticKind: null,
        diagnostic: null,
        progress: null,
        durationSeconds: null,
        result: null,
        scoreId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
      jobs.set(created.id, created);
      return structuredClone(created);
    },
    async markUploaded(owner, id, sizeBytes) {
      const job = mine(owner, id);
      return job === undefined || job.status !== 'awaiting-upload' ? null : update(job, { status: 'queued', sizeBytes });
    },
    async retry(owner, id) {
      const job = mine(owner, id);
      return job === undefined || job.status !== 'failed'
        ? null
        : update(job, { status: 'queued', attempts: 0, diagnostic: null, diagnosticKind: null, progress: null });
    },
    async delete(owner, id) {
      const job = mine(owner, id);
      if (job === undefined) return null;
      jobs.delete(id);
      return structuredClone(job);
    },
    async deleteAll(owner) {
      const keys: string[] = [];
      for (const [id, job] of jobs) {
        if (job.owner !== owner) continue;
        keys.push(job.audioKey);
        jobs.delete(id);
      }
      return keys;
    },
    async close() {},
  };
}
