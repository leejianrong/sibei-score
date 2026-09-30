import { afterEach, describe, expect, it } from 'vitest';
import type { JobStore, ScoreStore } from '@sibei/api';
import type { MigrationResult, Score } from '@sibei/model';
import { aScore, anEdit, creationOf, insert, update } from './helpers.js';

/**
 * The store contract, asserted once and run against every adapter (V19, ADR-0034).
 *
 * "The hosted transition is a change of implementation, not a rewrite" (ADR-0001) is true only for as
 * long as the two implementations cannot drift apart on anything a caller can observe. A test written
 * against one adapter proves that adapter; this proves the *port*. `tests/store/conformance.test.ts`
 * runs it on SQLite, `tests/postgres/conformance.test.ts` on Postgres, and a third adapter would join by
 * adding one file.
 *
 * What is deliberately **not** here is anything about mechanism — row-level security, advisory locks,
 * `SKIP LOCKED`, SQLite's file layout. Those are `tests/postgres/` and `tests/store/` proper.
 */

export interface Harness {
  store: ScoreStore;
  jobs: JobStore;
  close(): Promise<void>;
}

export interface OpenOptions {
  /** A clock, so timestamps and their ordering are asserted rather than tolerated. */
  now?: () => Date;
  /** Replaces the document migration chain, as `SqliteStoreOptions.migrate` does. */
  migrate?: (raw: unknown) => MigrationResult;
}

export type OpenHarness = (options?: OpenOptions) => Promise<Harness>;

/** A clock that moves forward one second each time it is read, so every write is a distinct instant. */
function ticking(startIso = '2026-08-01T00:00:00Z'): () => Date {
  let at = Date.parse(startIso);
  return () => {
    const now = new Date(at);
    at += 1000;
    return now;
  };
}

export function storeConformance(label: string, open: OpenHarness): void {
  const open_: Harness[] = [];
  afterEach(async () => {
    while (open_.length > 0) await open_.pop()?.close();
  });
  async function fresh(options?: OpenOptions): Promise<Harness> {
    const harness = await open(options);
    open_.push(harness);
    return harness;
  }

  describe(`${label}: the score store`, () => {
    it('creates at version 1 and reads back exactly the document that was written', async () => {
      const { store } = await fresh();
      const score = aScore('soul');
      const outcome = await insert(store, 'local', score);
      expect(outcome).toMatchObject({ ok: true, version: 1 });
      const record = await store.get('local', 'soul');
      expect(record?.version).toBe(1);
      expect(record?.score).toEqual(score);
      // Not merely equal: the same *bytes*. The export cache key is a digest of the serialised document
      // (Q81), so a store that reordered keys would silently change every cache key. This is what storing
      // JSON as text rather than jsonb buys, and it is asserted for every adapter.
      expect(JSON.stringify(record?.score)).toBe(JSON.stringify(score));
    });

    it('answers a miss with null and false, not an error', async () => {
      const { store } = await fresh();
      expect(await store.get('local', 'nope')).toBeNull();
      expect(await store.exists('local', 'nope')).toBe(false);
      expect(await store.delete('local', 'nope')).toBe(false);
      expect(await store.operations('local', 'nope')).toEqual([]);
    });

    it('bumps the version on a commit and reflects the new listing columns', async () => {
      const { store } = await fresh();
      await insert(store, 'local', aScore('soul', 'Body and Soul'));
      const outcome = await update(store, 'local', 'soul', 1, aScore('soul', 'Body & Soul'));
      expect(outcome).toMatchObject({ ok: true, version: 2 });
      expect((await store.get('local', 'soul'))?.version).toBe(2);
      const [row] = await store.list('local');
      expect(row).toMatchObject({ id: 'soul', title: 'Body & Soul', composer: 'Johnny Green', key: 'Db', version: 2 });
    });

    it('refuses a stale commit with the current version, and leaves the document alone', async () => {
      const { store } = await fresh();
      await insert(store, 'local', aScore('soul', 'Original'));
      await update(store, 'local', 'soul', 1, aScore('soul', 'Edited'));
      expect(await update(store, 'local', 'soul', 1, aScore('soul', 'Stale'))).toEqual({
        ok: false,
        reason: 'conflict',
        version: 2,
      });
      expect((await store.get('local', 'soul'))?.score.meta.title).toBe('Edited');
      expect(await store.operations('local', 'soul')).toHaveLength(2);
    });

    it('reports a commit to a score that is not there as not-found', async () => {
      const { store } = await fresh();
      expect(await update(store, 'local', 'ghost', 1, aScore('ghost'))).toEqual({ ok: false, reason: 'not-found' });
    });

    it('refuses a second create of the same id', async () => {
      const { store } = await fresh();
      await insert(store, 'local', aScore('soul'));
      expect(await insert(store, 'local', aScore('soul'))).toEqual({ ok: false, reason: 'already-exists' });
      expect(await store.operations('local', 'soul')).toHaveLength(1);
    });

    it('refuses a write that carries no operations (ADR-0003)', async () => {
      const { store } = await fresh();
      await expect(store.create('local', aScore('soul'), [])).rejects.toThrow(/must carry the operations/);
      await insert(store, 'local', aScore('soul'));
      await expect(store.commit('local', 'soul', 1, aScore('soul'), [])).rejects.toThrow(/must carry the operations/);
      expect((await store.get('local', 'soul'))?.version).toBe(1);
    });

    it('a write whose operations cannot be logged leaves the document untouched', async () => {
      const { store } = await fresh();
      await insert(store, 'local', aScore('soul', 'Before'));
      // A BigInt cannot be serialised, so the log write throws *after* the document write has begun. The
      // document and its operations land together or not at all (ADR-0003).
      const unloggable = [
        { seq: 0, batch: 0, version: 1, operation: { type: 'meta.set', payload: { n: 1n } } as never, createdAt: '2026-08-01T00:00:00Z' },
      ];
      await expect(store.commit('local', 'soul', 1, aScore('soul', 'After'), unloggable)).rejects.toThrow();
      const record = await store.get('local', 'soul');
      expect(record?.score.meta.title).toBe('Before');
      expect(record?.version).toBe(1);
      expect(await store.operations('local', 'soul')).toHaveLength(1);
    });

    it('numbers the log gapless from 1 and groups a batch into one undoable unit', async () => {
      const { store } = await fresh();
      await insert(store, 'local', aScore('soul'));
      await store.commit('local', 'soul', 1, aScore('soul'), [...anEdit(), ...anEdit()]);
      await store.commit('local', 'soul', 2, aScore('soul'), anEdit());
      const log = await store.operations('local', 'soul');
      expect(log.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
      expect(log.map((entry) => entry.batch)).toEqual([1, 2, 2, 3]);
    });

    it('returns each logged operation exactly as it was written', async () => {
      const { store } = await fresh();
      const score = aScore('soul');
      await store.create('local', score, creationOf(score));
      const [entry] = await store.operations('local', 'soul');
      expect(entry?.operation).toEqual(creationOf(score)[0]!.operation);
      expect(entry?.version).toBe(1);
      expect(entry?.createdAt).toBe('2026-07-31T09:15:30Z');
    });

    it('lists a library newest-edited first, then by id', async () => {
      const { store } = await fresh({ now: ticking() });
      await insert(store, 'local', aScore('b'));
      await insert(store, 'local', aScore('a'));
      await insert(store, 'local', aScore('c'));
      await update(store, 'local', 'b', 1, aScore('b'));
      expect((await store.list('local')).map((row) => row.id)).toEqual(['b', 'c', 'a']);
    });

    it('orders ids by byte value, not by locale, so every adapter agrees', async () => {
      // Two charts written in the same second tie on time and fall back to id. A locale collation would
      // put "blue" before "Soul"; byte order puts "Soul" first. SQLite is byte-ordered, and Postgres is
      // told to be (`COLLATE "C"`), so this is the assertion that would catch either drifting.
      const { store } = await fresh({ now: () => new Date('2026-08-01T00:00:00Z') });
      await insert(store, 'local', aScore('blue'));
      await insert(store, 'local', aScore('Soul'));
      await insert(store, 'local', aScore('alpha'));
      expect((await store.list('local')).map((row) => row.id)).toEqual(['Soul', 'alpha', 'blue']);
    });

    it('deletes a score together with its whole log', async () => {
      const { store } = await fresh();
      await insert(store, 'local', aScore('soul'));
      await update(store, 'local', 'soul', 1, aScore('soul'));
      expect(await store.delete('local', 'soul')).toBe(true);
      expect(await store.get('local', 'soul')).toBeNull();
      expect(await store.operations('local', 'soul')).toEqual([]);
    });

    describe('tenancy: a chart id is unique per owner', () => {
      it('lets two owners each have a chart with the same id, and never shows one the other', async () => {
        const { store } = await fresh();
        expect(await insert(store, 'alice', aScore('soul', "Alice's"))).toMatchObject({ ok: true });
        // Not `already-exists`: that id belongs to somebody else and is none of bob's business.
        expect(await insert(store, 'bob', aScore('soul', "Bob's"))).toMatchObject({ ok: true, version: 1 });
        expect((await store.get('alice', 'soul'))?.score.meta.title).toBe("Alice's");
        expect((await store.get('bob', 'soul'))?.score.meta.title).toBe("Bob's");
        await insert(store, 'bob', aScore('only-bob'));
        expect((await store.list('alice')).map((row) => row.id)).toEqual(['soul']);
        expect(await store.exists('alice', 'only-bob')).toBe(false);
        expect(await store.get('alice', 'only-bob')).toBeNull();
      });

      it('keeps each owner\'s log, versions and edits to themselves', async () => {
        const { store } = await fresh();
        await insert(store, 'alice', aScore('soul'));
        await insert(store, 'bob', aScore('soul'));
        await update(store, 'alice', 'soul', 1, aScore('soul', 'Alice v2'));
        expect((await store.operations('alice', 'soul')).map((entry) => entry.seq)).toEqual([1, 2]);
        expect((await store.operations('bob', 'soul')).map((entry) => entry.seq)).toEqual([1]);
        expect((await store.get('bob', 'soul'))?.version).toBe(1);
        expect(await update(store, 'bob', 'soul', 2, aScore('soul'))).toEqual({ ok: false, reason: 'conflict', version: 1 });
      });

      it('deletes only the caller\'s chart and log', async () => {
        const { store } = await fresh();
        await insert(store, 'alice', aScore('soul'));
        await insert(store, 'bob', aScore('soul'));
        expect(await store.delete('alice', 'soul')).toBe(true);
        expect(await store.operations('alice', 'soul')).toEqual([]);
        expect(await store.exists('bob', 'soul')).toBe(true);
        expect(await store.operations('bob', 'soul')).toHaveLength(1);
        // And a delete by someone who has no such chart touches nothing.
        expect(await store.delete('carol', 'soul')).toBe(false);
        expect(await store.exists('bob', 'soul')).toBe(true);
      });
    });

    describe('migration on read (ADR-0028)', () => {
      const retitled = (raw: unknown): MigrationResult => {
        const score = raw as Score;
        return { migrated: true, score: { ...score, meta: { ...score.meta, composer: 'MIGRATED' } } } as MigrationResult;
      };

      it('migrates a document on read and writes it back — without bumping the version', async () => {
        const { store } = await fresh({ migrate: retitled });
        await insert(store, 'local', aScore('soul'));
        const record = await store.get('local', 'soul');
        expect(record?.score.meta.composer).toBe('MIGRATED');
        // A migration is not an edit: bumping the version would make a plain read look like somebody
        // else's write and spuriously invalidate a client's expectedVersion (ADR-0003).
        expect(record?.version).toBe(1);
        const [row] = await store.list('local');
        expect(row).toMatchObject({ composer: 'MIGRATED', version: 1 }); // the listing column followed the write-back
      });

      it('lets a document this build cannot read fail loudly rather than be read best-effort', async () => {
        const { store } = await fresh({
          migrate: () => {
            throw new Error('newer than this build understands');
          },
        });
        await insert(store, 'local', aScore('soul'));
        await expect(store.get('local', 'soul')).rejects.toThrow('newer than this build understands');
      });
    });
  });
}

export function jobStoreConformance(label: string, open: OpenHarness): void {
  const open_: Harness[] = [];
  afterEach(async () => {
    while (open_.length > 0) await open_.pop()?.close();
  });
  async function fresh(options?: OpenOptions): Promise<Harness> {
    const harness = await open(options);
    open_.push(harness);
    return harness;
  }

  describe(`${label}: the job store`, () => {
    it('records a queued job with its images in page order, and a null engine by default', async () => {
      const { jobs } = await fresh();
      const job = await jobs.create('alice', ['p1', 'p2', 'p3']);
      expect(job).toMatchObject({
        owner: 'alice',
        status: 'queued',
        imageKeys: ['p1', 'p2', 'p3'],
        engine: null,
        attempts: 0,
        diagnostic: null,
        result: null,
        scoreId: null,
        version: 1,
      });
      expect((await jobs.create('alice', ['p1'], 'heuristic')).engine).toBe('heuristic');
    });

    it('refuses a job with no images', async () => {
      const { jobs } = await fresh();
      await expect(jobs.create('alice', [])).rejects.toThrow(/at least one image/);
    });

    it('lists an owner\'s jobs newest first, without their results, and never another owner\'s', async () => {
      const { jobs } = await fresh({ now: ticking() });
      const first = await jobs.create('alice', ['a']);
      const second = await jobs.create('alice', ['b']);
      await jobs.create('bob', ['c']);
      const listed = await jobs.list('alice');
      expect(listed.map((job) => job.id)).toEqual([second.id, first.id]);
      expect(listed[0]).not.toHaveProperty('result');
      expect(await jobs.get('bob', first.id)).toBeNull();
      expect((await jobs.get('alice', first.id))?.id).toBe(first.id);
    });

    it('claims the oldest queued job across owners, atomically, and counts the attempt', async () => {
      const { jobs } = await fresh({ now: ticking() });
      const older = await jobs.create('alice', ['a']);
      const newer = await jobs.create('bob', ['b']);
      const claimed = await jobs.claim();
      expect(claimed).toMatchObject({ id: older.id, status: 'running', attempts: 1, version: 2 });
      expect((await jobs.claim())?.id).toBe(newer.id);
      expect(await jobs.claim()).toBeNull();
    });

    it('never hands one job to two concurrent claimers', async () => {
      const { jobs } = await fresh({ now: ticking() });
      const made = await Promise.all(Array.from({ length: 8 }, (_, index) => jobs.create('alice', [`k${index}`])));
      const claims = await Promise.all(made.map(() => jobs.claim()));
      const ids = claims.map((job) => job?.id);
      expect(ids.every((id) => id !== undefined)).toBe(true);
      expect(new Set(ids).size).toBe(made.length);
    });

    it('completes only a running job, storing the recognised objects and the score it produced', async () => {
      const { jobs } = await fresh();
      const job = await jobs.create('alice', ['a']);
      expect(await jobs.complete(job.id, [], 'score-1')).toBeNull(); // still queued
      await jobs.claim();
      const result = [{ page: 1, nested: { b: 2, a: [1, 2] } }] as never;
      const done = await jobs.complete(job.id, result, 'score-1');
      expect(done).toMatchObject({ status: 'succeeded', scoreId: 'score-1', diagnostic: null });
      expect(done?.result).toEqual(result);
      expect((await jobs.get('alice', job.id))?.result).toEqual(result);
      expect(await jobs.complete(job.id, [], 'score-2')).toBeNull(); // terminal: cannot move twice
    });

    it('fails only a running job, with a diagnostic', async () => {
      const { jobs } = await fresh();
      const job = await jobs.create('alice', ['a']);
      expect(await jobs.fail(job.id, 'too early')).toBeNull();
      await jobs.claim();
      expect(await jobs.fail(job.id, 'worker exploded')).toMatchObject({ status: 'failed', diagnostic: 'worker exploded' });
      expect(await jobs.fail(job.id, 'again')).toBeNull();
    });

    it('retries only a failed job, and only for its owner', async () => {
      const { jobs } = await fresh();
      const job = await jobs.create('alice', ['a']);
      expect(await jobs.retry('alice', job.id)).toBeNull(); // queued, not failed
      await jobs.claim();
      await jobs.fail(job.id, 'boom');
      expect(await jobs.retry('bob', job.id)).toBeNull();
      expect(await jobs.retry('alice', job.id)).toMatchObject({ status: 'queued', diagnostic: null });
      expect((await jobs.claim())?.attempts).toBe(2); // the attempt count survives a retry
    });

    it('recovers every running job as failed, and leaves queued ones alone', async () => {
      const { jobs } = await fresh({ now: ticking() });
      const a = await jobs.create('alice', ['a']);
      const b = await jobs.create('alice', ['b']);
      await jobs.claim();
      expect(await jobs.recover('interrupted')).toBe(1);
      expect(await jobs.get('alice', a.id)).toMatchObject({ status: 'failed', diagnostic: 'interrupted' });
      expect((await jobs.get('alice', b.id))?.status).toBe('queued');
      expect(await jobs.recover('interrupted')).toBe(0);
    });

    it('finds the job that produced a score, for its owner only', async () => {
      const { jobs } = await fresh();
      const job = await jobs.create('alice', ['a']);
      expect(await jobs.getByScoreId('alice', 'score-1')).toBeNull();
      await jobs.claim();
      await jobs.complete(job.id, [], 'score-1');
      expect((await jobs.getByScoreId('alice', 'score-1'))?.id).toBe(job.id);
      expect(await jobs.getByScoreId('bob', 'score-1')).toBeNull();
    });
  });
}
