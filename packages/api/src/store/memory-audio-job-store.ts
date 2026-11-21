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
  const usage = new Map<AudioJobId, { owner: string; seconds: number; recordedAt: string }>();
  const stamp = () => `${now().toISOString().slice(0, 19)}Z`;
  const leaseUntil = (at: Date, seconds: number) => `${new Date(at.getTime() + seconds * 1000).toISOString().slice(0, 19)}Z`;

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
      const keys: { id: string; audioKey: string }[] = [];
      for (const [jobId, row] of usage) if (row.owner === owner) usage.delete(jobId);
      for (const [id, job] of jobs) {
        if (job.owner !== owner) continue;
        keys.push({ id, audioKey: job.audioKey });
        jobs.delete(id);
      }
      return keys;
    },
    async claim(leaseSeconds) {
      const queued = [...jobs.values()]
        .filter((job) => job.status === 'queued')
        .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))[0];
      if (queued === undefined) return null;
      return update(queued, {
        status: 'running',
        attempts: queued.attempts + 1,
        leaseToken: randomUUID(),
        leaseExpiresAt: leaseUntil(now(), leaseSeconds),
        progress: null,
      });
    },
    async heartbeat(id, leaseToken, leaseSeconds, progress) {
      const job = jobs.get(id);
      if (job === undefined || job.leaseToken !== leaseToken || job.status !== 'running') return { outcome: 'lease-lost' };
      return {
        outcome: 'ok',
        job: update(job, { leaseExpiresAt: leaseUntil(now(), leaseSeconds), progress: progress ?? job.progress }),
      };
    },
    async complete(id, leaseToken, result, durationSeconds) {
      const job = jobs.get(id);
      if (job === undefined || job.leaseToken !== leaseToken) return { outcome: 'lease-lost' };
      if (job.status === 'succeeded') return { outcome: 'already', job: structuredClone(job) };
      if (job.status !== 'running') return { outcome: 'lease-lost' };
      return {
        outcome: 'ok',
        job: update(job, { status: 'succeeded', result, durationSeconds, progress: null, diagnostic: null, diagnosticKind: null }),
      };
    },
    async fail(id, leaseToken, failure) {
      const job = jobs.get(id);
      if (job === undefined || job.leaseToken !== leaseToken) return { outcome: 'lease-lost' };
      if (job.status !== 'running') {
        return job.status === 'failed' || job.status === 'queued'
          ? { outcome: 'already', job: structuredClone(job) }
          : { outcome: 'lease-lost' };
      }
      const requeue = failure.retryable && job.attempts < failure.maxAttempts;
      return {
        outcome: 'ok',
        job: requeue
          ? update(job, { status: 'queued', progress: null })
          : update(job, { status: 'failed', diagnosticKind: failure.kind, diagnostic: failure.message, progress: null }),
      };
    },
    async expireLeases(maxAttempts) {
      const at = stamp();
      const requeued: AudioJob[] = [];
      const failed: AudioJob[] = [];
      for (const job of [...jobs.values()]) {
        if (job.status !== 'running' || job.leaseExpiresAt === null || !(job.leaseExpiresAt < at)) continue;
        if (job.attempts < maxAttempts) requeued.push(update(job, { status: 'queued', progress: null }));
        else
          failed.push(
            update(job, {
              status: 'failed',
              diagnosticKind: 'worker-lost',
              diagnostic: 'the transcription worker stopped responding',
              progress: null,
            }),
          );
      }
      return { requeued, failed };
    },
    async getById(id) {
      const job = jobs.get(id);
      return job === undefined ? null : structuredClone(job);
    },
    async attachScore(id, scoreId) {
      const job = jobs.get(id);
      return job === undefined ? null : update(job, { scoreId });
    },
    async rejectResult(id, kind, message) {
      const job = jobs.get(id);
      return job === undefined || job.status !== 'succeeded'
        ? null
        : update(job, { status: 'failed', diagnosticKind: kind, diagnostic: message });
    },
    async recordUsage(owner, jobId, seconds) {
      if (usage.has(jobId)) return false;
      usage.set(jobId, { owner, seconds, recordedAt: stamp() });
      return true;
    },
    async usageSince(owner, sinceIso) {
      let seconds = 0;
      let count = 0;
      for (const row of usage.values()) {
        if (row.owner === owner && row.recordedAt >= sinceIso) {
          seconds += row.seconds;
          count += 1;
        }
      }
      return { seconds, jobs: count };
    },
    async close() {},
  };
}
