import { afterEach, describe, expect, it } from 'vitest';
import type { AudioJobStore, AuthStore, BlobLedger, JobStore, ScoreStore } from '@sibei/api';
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
  audio: AudioJobStore;
  auth: AuthStore;
  ledger: BlobLedger;
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

    it('can record a diagnostic on a succeeded job (NoteEvents warnings, ADR-0040)', async () => {
      const { jobs } = await fresh();
      const job = await jobs.create('alice', ['a'], 'note-events');
      await jobs.claim();
      const done = await jobs.complete(job.id, [], 'score-1', 'silent_input: no audible signal');
      expect(done).toMatchObject({ status: 'succeeded', engine: 'note-events', diagnostic: 'silent_input: no audible signal' });
      expect((await jobs.get('alice', job.id))?.diagnostic).toBe('silent_input: no audible signal');
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

export function authStoreConformance(label: string, open: OpenHarness): void {
  const open_: Harness[] = [];
  afterEach(async () => {
    while (open_.length > 0) await open_.pop()?.close();
  });
  async function fresh(options?: OpenOptions): Promise<Harness> {
    const harness = await open(options);
    open_.push(harness);
    return harness;
  }
  const octocat = { provider: 'github', subject: '583231', login: 'octocat', name: 'The Octocat' };

  describe(`${label}: the identity store (V20)`, () => {
    it('creates a user on first sign-in and returns the same one every time after', async () => {
      const { auth } = await fresh({ now: ticking() });
      const first = await auth.signIn(octocat);
      expect(first.id).toMatch(/^usr_/);
      expect(first).toMatchObject({ login: 'octocat', name: 'The Octocat', createdAt: '2026-08-01T00:00:00Z' });
      const again = await auth.signIn(octocat);
      expect(again.id).toBe(first.id);
      expect(again.createdAt).toBe(first.createdAt);
    });

    it('keys the user by the provider subject, so a renamed login is still the same person', async () => {
      const { auth } = await fresh();
      const before = await auth.signIn(octocat);
      const after = await auth.signIn({ ...octocat, login: 'octo-renamed', name: null });
      expect(after.id).toBe(before.id);
      expect(await auth.getUser(before.id)).toMatchObject({ login: 'octo-renamed', name: null });
    });

    it('does not merge two people, or the same subject under two providers', async () => {
      const { auth } = await fresh();
      const a = await auth.signIn(octocat);
      const b = await auth.signIn({ ...octocat, subject: '9' });
      const c = await auth.signIn({ ...octocat, provider: 'google' });
      expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    });

    it('makes one user of one person signing in for the first time twice at once', async () => {
      const { auth } = await fresh();
      const users = await Promise.all(Array.from({ length: 6 }, () => auth.signIn(octocat)));
      expect(new Set(users.map((user) => user.id)).size).toBe(1);
    });

    it('answers null for a user that does not exist', async () => {
      const { auth } = await fresh();
      expect(await auth.getUser('usr_nobody')).toBeNull();
    });

    it('finds a live session by its hash, and only by its hash', async () => {
      const { auth } = await fresh();
      const user = await auth.signIn(octocat);
      await auth.createSession('hash-1', user.id, '2026-09-01T00:00:00Z');
      expect(await auth.findSession('hash-1', '2026-08-01T00:00:00Z')).toEqual({
        userId: user.id,
        expiresAt: '2026-09-01T00:00:00Z',
      });
      expect(await auth.findSession('hash-2', '2026-08-01T00:00:00Z')).toBeNull();
    });

    it('treats a session as gone from the instant it expires, without any purge having run', async () => {
      const { auth } = await fresh();
      const user = await auth.signIn(octocat);
      await auth.createSession('h', user.id, '2026-09-01T00:00:00Z');
      expect(await auth.findSession('h', '2026-08-31T23:59:59Z')).not.toBeNull();
      expect(await auth.findSession('h', '2026-09-01T00:00:00Z')).toBeNull();
      expect(await auth.findSession('h', '2026-10-01T00:00:00Z')).toBeNull();
    });

    it('ends a session, and signing out twice is not an error', async () => {
      const { auth } = await fresh();
      const user = await auth.signIn(octocat);
      await auth.createSession('h', user.id, '2026-09-01T00:00:00Z');
      expect(await auth.deleteSession('h')).toBe(true);
      expect(await auth.findSession('h', '2026-08-01T00:00:00Z')).toBeNull();
      expect(await auth.deleteSession('h')).toBe(false);
    });

    it('purges only the sessions that have expired', async () => {
      const { auth } = await fresh();
      const user = await auth.signIn(octocat);
      await auth.createSession('old', user.id, '2026-08-01T00:00:00Z');
      await auth.createSession('new', user.id, '2026-12-01T00:00:00Z');
      expect(await auth.purgeExpiredSessions('2026-09-01T00:00:00Z')).toBe(1);
      expect(await auth.findSession('new', '2026-09-01T00:00:00Z')).not.toBeNull();
      expect(await auth.purgeExpiredSessions('2026-09-01T00:00:00Z')).toBe(0);
    });

    it('refuses a session for a user that does not exist', async () => {
      const { auth } = await fresh();
      await expect(auth.createSession('h', 'usr_nobody', '2026-09-01T00:00:00Z')).rejects.toThrow();
    });
  });

  describe(`${label}: device authorisation and API tokens (V21a)`, () => {
    const T0 = '2026-08-01T00:00:00Z';
    const T_LATER = '2026-08-01T00:05:00Z';
    const T_EXPIRED = '2026-08-01T00:10:00Z';
    const device = { deviceHash: 'dev-hash', userCode: 'BCDFGHJK', expiresAt: T_EXPIRED };

    async function aUser(auth: AuthStore) {
      return auth.signIn(octocat);
    }

    it('answers a poll as pending until a person approves, then hands over what to mint — once', async () => {
      const { auth } = await fresh();
      const user = await aUser(auth);
      await auth.createDevice(device);
      expect(await auth.pollDevice('dev-hash', T0, 0)).toEqual({ status: 'pending' });
      expect(await auth.approveDevice('BCDFGHJK', { userId: user.id, name: 'laptop', scopes: ['read', 'write'] }, T0)).toBe(true);
      expect(await auth.pollDevice('dev-hash', T_LATER, 0)).toEqual({
        status: 'authorized',
        userId: user.id,
        name: 'laptop',
        scopes: ['read', 'write'],
      });
      // Spent by the poll that returned it: a second presentation of the same device code is not an answer.
      expect(await auth.pollDevice('dev-hash', T_LATER, 0)).toEqual({ status: 'expired' });
    });

    it('lets a code approve only once, and not at all after it expires or if it never existed', async () => {
      const { auth } = await fresh();
      const user = await aUser(auth);
      const approval = { userId: user.id, name: 'laptop', scopes: ['read'] as const };
      await auth.createDevice(device);
      expect(await auth.approveDevice('ZZZZZZZZ', approval, T0)).toBe(false);
      expect(await auth.approveDevice('BCDFGHJK', approval, T_EXPIRED)).toBe(false);
      expect(await auth.approveDevice('BCDFGHJK', approval, T0)).toBe(true);
      expect(await auth.approveDevice('BCDFGHJK', approval, T0)).toBe(false);
    });

    it('treats a device code as gone from the instant it expires', async () => {
      const { auth } = await fresh();
      await auth.createDevice(device);
      expect(await auth.pollDevice('dev-hash', '2026-08-01T00:09:59Z', 0)).toEqual({ status: 'pending' });
      expect(await auth.pollDevice('dev-hash', T_EXPIRED, 0)).toEqual({ status: 'expired' });
    });

    it('does not let an expired approval be collected', async () => {
      const { auth } = await fresh();
      const user = await aUser(auth);
      await auth.createDevice(device);
      await auth.approveDevice('BCDFGHJK', { userId: user.id, name: 'x', scopes: ['read'] }, T0);
      expect(await auth.pollDevice('dev-hash', T_EXPIRED, 0)).toEqual({ status: 'expired' });
    });

    it('tells a poller that comes back too soon to slow down, and does not reset its clock for doing so', async () => {
      const { auth } = await fresh();
      await auth.createDevice(device);
      expect(await auth.pollDevice('dev-hash', '2026-08-01T00:00:00Z', 5_000)).toEqual({ status: 'pending' });
      expect(await auth.pollDevice('dev-hash', '2026-08-01T00:00:02Z', 5_000)).toEqual({ status: 'slow-down' });
      expect(await auth.pollDevice('dev-hash', '2026-08-01T00:00:04Z', 5_000)).toEqual({ status: 'slow-down' });
      expect(await auth.pollDevice('dev-hash', '2026-08-01T00:00:05Z', 5_000)).toEqual({ status: 'pending' });
    });

    it('lets exactly one of several concurrent polls collect an approval', async () => {
      const { auth } = await fresh();
      const user = await aUser(auth);
      await auth.createDevice(device);
      await auth.approveDevice('BCDFGHJK', { userId: user.id, name: 'x', scopes: ['read'] }, T0);
      const polls = await Promise.all(Array.from({ length: 6 }, () => auth.pollDevice('dev-hash', T_LATER, 0)));
      expect(polls.filter((p) => p.status === 'authorized')).toHaveLength(1);
    });

    it('refuses two live device codes with the same user code', async () => {
      const { auth } = await fresh();
      await auth.createDevice(device);
      await expect(auth.createDevice({ ...device, deviceHash: 'other' })).rejects.toThrow();
    });

    it('mints a token, finds it by hash while it lives, and never finds a hash it was not given', async () => {
      const { auth } = await fresh();
      const user = await aUser(auth);
      const made = await auth.createToken({
        id: 'tok_1',
        tokenHash: 'h1',
        userId: user.id,
        name: 'laptop',
        scopes: ['read'],
        expiresAt: '2026-11-01T00:00:00Z',
      });
      expect(made).toEqual({
        id: 'tok_1',
        name: 'laptop',
        scopes: ['read'],
        createdAt: expect.any(String),
        expiresAt: '2026-11-01T00:00:00Z',
      });
      expect(await auth.findToken('h1', T0)).toEqual({ id: 'tok_1', userId: user.id, scopes: ['read'] });
      expect(await auth.findToken('h2', T0)).toBeNull();
    });

    it('treats a token as gone from the instant it expires, with no purge needed', async () => {
      const { auth } = await fresh();
      const user = await aUser(auth);
      await auth.createToken({ id: 'tok_1', tokenHash: 'h1', userId: user.id, name: 'x', scopes: ['read'], expiresAt: '2026-09-01T00:00:00Z' });
      expect(await auth.findToken('h1', '2026-08-31T23:59:59Z')).not.toBeNull();
      expect(await auth.findToken('h1', '2026-09-01T00:00:00Z')).toBeNull();
    });

    it('lists only the caller\'s tokens, newest first, and never a hash', async () => {
      const { auth } = await fresh({ now: ticking() });
      const alice = await aUser(auth);
      const bob = await auth.signIn({ ...octocat, subject: '2', login: 'bob' });
      const base = { scopes: ['read'] as const, expiresAt: '2026-11-01T00:00:00Z' };
      await auth.createToken({ id: 'tok_a1', tokenHash: 'a1', userId: alice.id, name: 'first', ...base });
      await auth.createToken({ id: 'tok_a2', tokenHash: 'a2', userId: alice.id, name: 'second', ...base });
      await auth.createToken({ id: 'tok_b1', tokenHash: 'b1', userId: bob.id, name: 'bobs', ...base });
      const listed = await auth.listTokens(alice.id);
      expect(listed.map((t) => t.id)).toEqual(['tok_a2', 'tok_a1']);
      // The hashes ('a1', 'a2') are the stored secret form; a listing carries neither them nor a field for one.
      const text = JSON.stringify(listed);
      expect(text).not.toContain('"a1"');
      expect(text).not.toContain('"a2"');
      expect(text.toLowerCase()).not.toContain('hash');
    });

    it('revokes a token at once, and only for its owner', async () => {
      const { auth } = await fresh();
      const alice = await aUser(auth);
      const bob = await auth.signIn({ ...octocat, subject: '2', login: 'bob' });
      await auth.createToken({ id: 'tok_a', tokenHash: 'ha', userId: alice.id, name: 'x', scopes: ['read'], expiresAt: '2026-11-01T00:00:00Z' });
      expect(await auth.revokeToken(bob.id, 'tok_a')).toBe(false);
      expect(await auth.findToken('ha', T0)).not.toBeNull();
      expect(await auth.revokeToken(alice.id, 'tok_a')).toBe(true);
      expect(await auth.findToken('ha', T0)).toBeNull();
      expect(await auth.revokeToken(alice.id, 'tok_a')).toBe(false);
    });

    it('refuses a token for a user that does not exist', async () => {
      const { auth } = await fresh();
      await expect(
        auth.createToken({ id: 'tok_z', tokenHash: 'hz', userId: 'usr_nobody', name: 'x', scopes: ['read'], expiresAt: '2026-11-01T00:00:00Z' }),
      ).rejects.toThrow();
    });

    it('purges only the device codes and tokens that have expired', async () => {
      const { auth } = await fresh();
      const user = await aUser(auth);
      await auth.createDevice({ deviceHash: 'old', userCode: 'AAAAAAAA', expiresAt: '2026-08-01T00:00:00Z' });
      await auth.createDevice({ deviceHash: 'new', userCode: 'BBBBBBBB', expiresAt: '2026-12-01T00:00:00Z' });
      await auth.createToken({ id: 'tok_old', tokenHash: 'ho', userId: user.id, name: 'x', scopes: ['read'], expiresAt: '2026-08-01T00:00:00Z' });
      await auth.createToken({ id: 'tok_new', tokenHash: 'hn', userId: user.id, name: 'x', scopes: ['read'], expiresAt: '2026-12-01T00:00:00Z' });
      expect(await auth.purgeExpiredCredentials('2026-09-01T00:00:00Z')).toBe(2);
      expect(await auth.findToken('hn', '2026-09-01T00:00:00Z')).not.toBeNull();
      expect(await auth.pollDevice('new', '2026-09-01T00:00:00Z', 0)).toEqual({ status: 'pending' });
      expect(await auth.purgeExpiredCredentials('2026-09-01T00:00:00Z')).toBe(0);
    });
  });

  describe(`${label}: OAuth authorisation codes (V22a)`, () => {
    const T0 = '2026-08-01T00:00:00Z';
    const aUser = (auth: AuthStore) => auth.signIn(octocat);
    const grant = {
      clientId: 'sbc_x',
      redirectUri: 'http://127.0.0.1:9999/cb',
      codeChallenge: 'chal',
      scopes: ['mcp:read', 'mcp:write'] as const,
      name: 'An agent',
    };

    it('spends a code exactly once, returning what it was granted', async () => {
      const { auth } = await fresh();
      const user = await aUser(auth);
      await auth.createAuthCode({ codeHash: 'c1', userId: user.id, expiresAt: '2026-10-01T00:00:00Z', ...grant });
      expect(await auth.consumeAuthCode('c1', T0)).toEqual({ userId: user.id, ...grant });
      expect(await auth.consumeAuthCode('c1', T0)).toBeNull();
    });

    it('treats an expired code as gone, and spends it', async () => {
      const { auth } = await fresh();
      const user = await aUser(auth);
      await auth.createAuthCode({ codeHash: 'c1', userId: user.id, expiresAt: '2026-09-01T00:00:00Z', ...grant });
      expect(await auth.consumeAuthCode('c1', '2026-09-01T00:00:00Z')).toBeNull();
      expect(await auth.consumeAuthCode('c1', T0)).toBeNull();
    });

    it('never lets two concurrent exchanges both win', async () => {
      const { auth } = await fresh();
      const user = await aUser(auth);
      await auth.createAuthCode({ codeHash: 'c1', userId: user.id, expiresAt: '2026-10-01T00:00:00Z', ...grant });
      const results = await Promise.all([auth.consumeAuthCode('c1', T0), auth.consumeAuthCode('c1', T0)]);
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });

    it('round-trips the MCP scopes on a token and purges expired codes', async () => {
      const { auth } = await fresh();
      const user = await aUser(auth);
      await auth.createToken({ id: 'tok_m', tokenHash: 'hm', userId: user.id, name: 'x', scopes: ['mcp:read'], expiresAt: '2026-11-01T00:00:00Z' });
      expect(await auth.findToken('hm', T0)).toEqual({ id: 'tok_m', userId: user.id, scopes: ['mcp:read'] });
      await auth.createAuthCode({ codeHash: 'old', userId: user.id, expiresAt: '2026-08-01T00:00:00Z', ...grant });
      expect(await auth.purgeExpiredCredentials('2026-09-01T00:00:00Z')).toBe(1);
    });
  });
}

/**
 * The audio-job store's contract (SIB2-137): the user-facing half — create, confirm the upload, list,
 * show, retry, delete. The worker half (lease, heartbeat, complete) joins in SIB2-138.
 */
export function audioJobStoreConformance(label: string, open: OpenHarness): void {
  const open_: Harness[] = [];
  afterEach(async () => {
    while (open_.length > 0) await open_.pop()?.close();
  });
  async function fresh(options?: OpenOptions): Promise<Harness> {
    const harness = await open(options);
    open_.push(harness);
    return harness;
  }
  const upload = (name = 'take1.wav') => ({
    audioKey: `audio:${name}`,
    contentType: 'audio/wav',
    filename: name,
    sizeBytes: 1000,
    instrument: null,
    declaredDurationSeconds: 12.5,
  });

  describe(`${label}: the audio job store`, () => {
    it('records an awaiting-upload job carrying what the client declared, with no lease and no result', async () => {
      const { audio } = await fresh();
      const job = await audio.create('alice', { ...upload(), instrument: 'piano' });
      expect(job).toMatchObject({
        owner: 'alice',
        status: 'awaiting-upload',
        audioKey: 'audio:take1.wav',
        contentType: 'audio/wav',
        filename: 'take1.wav',
        sizeBytes: 1000,
        instrument: 'piano',
        declaredDurationSeconds: 12.5,
        attempts: 0,
        diagnostic: null,
        diagnosticKind: null,
        progress: null,
        durationSeconds: null,
        result: null,
        scoreId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        version: 1,
      });
      expect(job.id).toBeTruthy();
    });

    it('lists an owner\'s jobs newest first, without results or lease tokens, and never another owner\'s', async () => {
      const { audio } = await fresh({ now: ticking() });
      const first = await audio.create('alice', upload('a.wav'));
      const second = await audio.create('alice', upload('b.wav'));
      await audio.create('bob', upload('c.wav'));
      const listed = await audio.list('alice');
      expect(listed.map((job) => job.id)).toEqual([second.id, first.id]);
      for (const summary of listed) {
        expect(summary).not.toHaveProperty('result');
        expect(summary).not.toHaveProperty('leaseToken');
      }
      expect(await audio.get('bob', first.id)).toBeNull();
      expect((await audio.get('alice', first.id))?.id).toBe(first.id);
    });

    it('moves awaiting-upload to queued once, replacing the declared size with the confirmed one', async () => {
      const { audio } = await fresh();
      const job = await audio.create('alice', upload());
      expect(await audio.markUploaded('bob', job.id, 5)).toBeNull();
      const queued = await audio.markUploaded('alice', job.id, 4321);
      expect(queued).toMatchObject({ status: 'queued', sizeBytes: 4321, version: 2 });
      expect(await audio.markUploaded('alice', job.id, 99)).toBeNull();
      expect((await audio.get('alice', job.id))?.sizeBytes).toBe(4321);
    });

    it('only retries a failed job, and only for its owner', async () => {
      const { audio } = await fresh();
      const job = await audio.create('alice', upload());
      expect(await audio.retry('alice', job.id)).toBeNull(); // awaiting-upload, not failed
      await audio.markUploaded('alice', job.id, 10);
      expect(await audio.retry('alice', job.id)).toBeNull(); // queued, not failed
      expect(await audio.retry('bob', 'nope')).toBeNull();
    });

    it('deletes a job for its owner only, handing back the row', async () => {
      const { audio } = await fresh();
      const job = await audio.create('alice', upload());
      expect(await audio.delete('bob', job.id)).toBeNull();
      expect((await audio.delete('alice', job.id))?.audioKey).toBe('audio:take1.wav');
      expect(await audio.get('alice', job.id)).toBeNull();
      expect(await audio.delete('alice', job.id)).toBeNull();
    });
  });

  /** A clock the test moves by hand, so a lease can be seen to expire. */
  function manual(startIso = '2026-12-01T10:00:00Z') {
    const clock = { at: Date.parse(startIso) };
    return { clock, now: () => new Date(clock.at) };
  }
  async function queued(audio: AudioJobStore, owner = 'alice', name = 'a.wav') {
    const job = await audio.create(owner, upload(name));
    return (await audio.markUploaded(owner, job.id, 10))!;
  }

  describe(`${label}: the audio job store, worker half (SIB2-138)`, () => {
    it('claims the oldest queued job across owners, with a fresh lease, and nothing else', async () => {
      const { clock, now } = manual();
      const { audio } = await fresh({ now });
      expect(await audio.claim(120)).toBeNull();
      await audio.create('alice', upload('not-uploaded.wav')); // awaiting-upload: not claimable
      const older = await queued(audio, 'alice', 'old.wav');
      clock.at += 1000;
      const newer = await queued(audio, 'bob', 'new.wav');
      const first = await audio.claim(120);
      expect(first).toMatchObject({ id: older.id, status: 'running', attempts: 1, leaseExpiresAt: '2026-12-01T10:02:01Z' });
      expect(first!.leaseToken).toBeTruthy();
      expect((await audio.claim(120))?.id).toBe(newer.id);
      expect(await audio.claim(120)).toBeNull();
    });

    it('lets many claimers race and hands each a different job', async () => {
      const { audio } = await fresh();
      for (let i = 0; i < 6; i += 1) await queued(audio, 'alice', `k${i}.wav`);
      const claims = await Promise.all(Array.from({ length: 6 }, () => audio.claim(120)));
      expect(new Set(claims.map((c) => c?.id)).size).toBe(6);
    });

    it('extends a lease and records progress, only for the token that holds it', async () => {
      const { clock, now } = manual();
      const { audio } = await fresh({ now });
      await queued(audio);
      const job = (await audio.claim(120))!;
      clock.at += 60_000;
      const beat = await audio.heartbeat(job.id, job.leaseToken!, 120, { stage: 'transcribing', fraction: 0.4 });
      expect(beat).toMatchObject({ outcome: 'ok', job: { leaseExpiresAt: '2026-12-01T10:03:00Z', progress: { stage: 'transcribing', fraction: 0.4 } } });
      expect(await audio.heartbeat(job.id, 'not-the-token', 120, null)).toEqual({ outcome: 'lease-lost' });
      expect(await audio.heartbeat('nope', job.leaseToken!, 120, null)).toEqual({ outcome: 'lease-lost' });
    });

    it('completes once, and a repeat with the same token is the same answer and changes nothing', async () => {
      const { audio } = await fresh();
      await queued(audio);
      const job = (await audio.claim(120))!;
      const result = { schema_version: 1, notes: [] };
      const done = await audio.complete(job.id, job.leaseToken!, result, 12.25);
      expect(done).toMatchObject({ outcome: 'ok', job: { status: 'succeeded', durationSeconds: 12.25, result } });
      const again = await audio.complete(job.id, job.leaseToken!, { schema_version: 1, notes: ['different'] }, 99);
      expect(again).toMatchObject({ outcome: 'already', job: { status: 'succeeded', durationSeconds: 12.25, result } });
      expect(await audio.complete(job.id, 'other-token', result, 1)).toEqual({ outcome: 'lease-lost' });
    });

    it('re-queues a retryable failure until attempts run out, then fails it for good', async () => {
      const { audio } = await fresh();
      await queued(audio);
      const failure = { kind: 'engine-error', message: 'boom', retryable: true, maxAttempts: 2 };
      const first = (await audio.claim(120))!;
      expect(await audio.fail(first.id, first.leaseToken!, failure)).toMatchObject({ outcome: 'ok', job: { status: 'queued', attempts: 1 } });
      // The same lease repeating itself is not a second failure.
      expect(await audio.fail(first.id, first.leaseToken!, failure)).toMatchObject({ outcome: 'already', job: { status: 'queued' } });
      const second = (await audio.claim(120))!;
      expect(second.attempts).toBe(2);
      expect(await audio.complete(first.id, first.leaseToken!, {}, 1)).toEqual({ outcome: 'lease-lost' }); // the old lease is dead
      expect(await audio.fail(second.id, second.leaseToken!, failure)).toMatchObject({
        outcome: 'ok',
        job: { status: 'failed', diagnosticKind: 'engine-error', diagnostic: 'boom' },
      });
    });

    it('fails a non-retryable failure at once', async () => {
      const { audio } = await fresh();
      await queued(audio);
      const job = (await audio.claim(120))!;
      const out = await audio.fail(job.id, job.leaseToken!, { kind: 'unsupported-audio', message: 'no audio stream', retryable: false, maxAttempts: 3 });
      expect(out).toMatchObject({ outcome: 'ok', job: { status: 'failed', diagnosticKind: 'unsupported-audio' } });
    });

    it('expires a stalled lease: re-queued while attempts remain, failed as worker-lost after', async () => {
      const { clock, now } = manual();
      const { audio } = await fresh({ now });
      await queued(audio);
      const job = (await audio.claim(120))!;
      expect(await audio.expireLeases(2)).toEqual({ requeued: [], failed: [] }); // not yet
      clock.at += 121_000;
      const first = await audio.expireLeases(2);
      expect(first.requeued.map((j) => j.id)).toEqual([job.id]);
      expect(first.failed).toEqual([]);
      expect(await audio.heartbeat(job.id, job.leaseToken!, 120, null)).toEqual({ outcome: 'lease-lost' });

      const again = (await audio.claim(120))!;
      expect(again.attempts).toBe(2);
      clock.at += 121_000;
      const last = await audio.expireLeases(2);
      expect(last.failed.map((j) => [j.id, j.status, j.diagnosticKind])).toEqual([[job.id, 'failed', 'worker-lost']]);
    });

    it('keeps an audio-second ledger: one row per job, idempotent, per owner, counted from a date', async () => {
      const { clock, now } = manual('2026-12-01T10:00:00Z');
      const { audio } = await fresh({ now });
      expect(await audio.usageSince('alice', '2026-12-01T00:00:00Z')).toEqual({ seconds: 0, jobs: 0 });
      expect(await audio.recordUsage('alice', 'job-1', 12.5)).toBe(true);
      expect(await audio.recordUsage('alice', 'job-1', 99)).toBe(false); // a retry adds nothing, not even a corrected figure
      clock.at += 86_400_000;
      expect(await audio.recordUsage('alice', 'job-2', 7.5)).toBe(true);
      expect(await audio.recordUsage('bob', 'job-3', 100)).toBe(true);
      expect(await audio.usageSince('alice', '2026-12-01T00:00:00Z')).toEqual({ seconds: 20, jobs: 2 });
      expect(await audio.usageSince('alice', '2026-12-02T00:00:00Z')).toEqual({ seconds: 7.5, jobs: 1 });
      expect(await audio.usageSince('bob', '2026-12-01T00:00:00Z')).toEqual({ seconds: 100, jobs: 1 });
    });

    it('records the score an import produced, or rejects a result the importer refused', async () => {
      const { audio } = await fresh();
      await queued(audio);
      const job = (await audio.claim(120))!;
      await audio.complete(job.id, job.leaseToken!, { ok: true }, 3);
      expect((await audio.attachScore(job.id, 'score-1', 'inferred: C minor'))).toMatchObject({ scoreId: 'score-1', diagnostic: 'inferred: C minor' });
      expect(await audio.rejectResult(job.id, 'invalid-result', 'not NoteEvents')).toMatchObject({
        status: 'failed',
        diagnosticKind: 'invalid-result',
        result: { ok: true },
      });
      expect(await audio.rejectResult(job.id, 'invalid-result', 'again')).toBeNull(); // no longer succeeded
      expect((await audio.getById(job.id))?.status).toBe('failed');
      expect(await audio.getById('nope')).toBeNull();
    });
  });
}

/**
 * Account erasure and the blob ledger (V25): the store-level halves of `DELETE /v1/auth/account`. Each
 * adapter must delete exactly one owner's data and leave every other owner's whole.
 */
export function accountErasureConformance(label: string, open: OpenHarness): void {
  const open_: Harness[] = [];
  afterEach(async () => {
    while (open_.length > 0) await open_.pop()?.close();
  });
  async function fresh(options?: OpenOptions): Promise<Harness> {
    const harness = await open(options);
    open_.push(harness);
    return harness;
  }

  describe(`${label}: account erasure (V25)`, () => {
    it('deletes every score and op log an owner has, and only theirs', async () => {
      const { store } = await fresh();
      await insert(store, 'alice', aScore('one'));
      await insert(store, 'alice', aScore('two'));
      await insert(store, 'bob', aScore('one'));
      expect(await store.deleteAll('alice')).toBe(2);
      expect(await store.list('alice')).toEqual([]);
      expect(await store.operations('alice', 'one')).toEqual([]);
      expect((await store.list('bob')).map((row) => row.id)).toEqual(['one']);
      expect(await store.operations('bob', 'one')).toHaveLength(1);
      expect(await store.deleteAll('alice')).toBe(0);
    });

    it("deletes an owner's jobs and hands back their image keys, and only theirs", async () => {
      const { jobs } = await fresh();
      await jobs.create('alice', ['a1', 'a2']);
      await jobs.create('alice', ['a3']);
      const bobs = await jobs.create('bob', ['b1']);
      expect((await jobs.deleteAll('alice')).sort()).toEqual(['a1', 'a2', 'a3']);
      expect(await jobs.list('alice')).toEqual([]);
      expect((await jobs.get('bob', bobs.id))?.imageKeys).toEqual(['b1']);
      expect(await jobs.deleteAll('alice')).toEqual([]);
    });

    it("deletes an owner's audio jobs and hands back their audio keys, and only theirs", async () => {
      const { audio } = await fresh();
      const job = { contentType: 'audio/mpeg', filename: null, sizeBytes: 10, instrument: null, declaredDurationSeconds: null };
      await audio.create('alice', { ...job, audioKey: 'audio:a1' });
      await audio.create('alice', { ...job, audioKey: 'audio:a2' });
      const bobs = await audio.create('bob', { ...job, audioKey: 'audio:b1' });
      expect((await audio.deleteAll('alice')).map((job) => job.audioKey).sort()).toEqual(['audio:a1', 'audio:a2']);
      expect(await audio.list('alice')).toEqual([]);
      expect((await audio.get('bob', bobs.id))?.audioKey).toBe('audio:b1');
      expect(await audio.deleteAll('alice')).toEqual([]);
    });

    it("deletes an owner's metering ledger with their audio jobs", async () => {
      const { audio } = await fresh();
      await audio.recordUsage('alice', 'job-a', 30);
      await audio.recordUsage('bob', 'job-b', 60);
      await audio.deleteAll('alice');
      expect((await audio.usageSince('alice', '1970-01-01T00:00:00Z')).seconds).toBe(0);
      expect((await audio.usageSince('bob', '1970-01-01T00:00:00Z')).seconds).toBe(60);
    });

    it('deletes a user with their identities, sessions and tokens, and answers false the second time', async () => {
      const { auth } = await fresh();
      const alice = await auth.signIn({ provider: 'github', subject: '1', login: 'alice', name: null });
      const bob = await auth.signIn({ provider: 'github', subject: '2', login: 'bob', name: null });
      await auth.createSession('alice-session', alice.id, '2099-01-01T00:00:00Z');
      await auth.createSession('bob-session', bob.id, '2099-01-01T00:00:00Z');
      await auth.createToken({ id: 'tok_a', tokenHash: 'ha', userId: alice.id, name: 'x', scopes: ['read'], expiresAt: '2099-01-01T00:00:00Z' });
      expect(await auth.deleteUser(alice.id)).toBe(true);
      expect(await auth.getUser(alice.id)).toBeNull();
      expect(await auth.findSession('alice-session', '2026-01-01T00:00:00Z')).toBeNull();
      expect(await auth.findToken('ha', '2026-01-01T00:00:00Z')).toBeNull();
      expect(await auth.listTokens(alice.id)).toEqual([]);
      expect(await auth.findSession('bob-session', '2026-01-01T00:00:00Z')).not.toBeNull();
      expect(await auth.deleteUser(alice.id)).toBe(false);
      // signing in again with the same GitHub identity is a *new* user, not the old one back
      expect((await auth.signIn({ provider: 'github', subject: '1', login: 'alice', name: null })).id).not.toBe(alice.id);
    });

    it('records blobs per owner, idempotently, and forgets them', async () => {
      const { ledger } = await fresh({ now: ticking() });
      await ledger.record('alice', 'k1', 'export');
      await ledger.record('alice', 'k1', 'export');
      await ledger.record('alice', 'k2', 'import-source');
      await ledger.record('bob', 'k1', 'export');
      expect((await ledger.list('alice')).map((ref) => [ref.key, ref.kind])).toEqual([
        ['k1', 'export'],
        ['k2', 'import-source'],
      ]);
      await ledger.forget('alice', 'k1');
      expect((await ledger.list('alice')).map((ref) => ref.key)).toEqual(['k2']);
      await ledger.forgetAll('alice');
      expect(await ledger.list('alice')).toEqual([]);
      expect((await ledger.list('bob')).map((ref) => ref.key)).toEqual(['k1']);
    });

    it('finds blobs of a kind older than a cutoff, across owners, oldest first', async () => {
      const { ledger } = await fresh({ now: ticking('2026-08-01T00:00:00Z') });
      await ledger.record('alice', 'old', 'export'); // :00
      await ledger.record('bob', 'other-kind', 'import-source'); // :01
      await ledger.record('bob', 'mid', 'export'); // :02
      await ledger.record('alice', 'new', 'export'); // :03
      const found = await ledger.olderThan('export', '2026-08-01T00:00:03Z', 10);
      expect(found.map((ref) => [ref.owner, ref.key])).toEqual([
        ['alice', 'old'],
        ['bob', 'mid'],
      ]);
      expect(await ledger.olderThan('export', '2026-08-01T00:00:03Z', 1)).toHaveLength(1);
    });
  });
}
