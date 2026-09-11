import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteJobStore } from '@sibei/api/sqlite';
import type { JobStore } from '@sibei/api';
import { OMR_SCHEMA_VERSION } from '@sibei/model';
import type { OmrDocument } from '@sibei/model';

/**
 * The SQLite job store (V10): the durable half of "OMR is a job, not a request" (ADR-0001). Infra
 * layer, because it is the real adapter over a real (in-memory) SQLite database — the same table of
 * transitions the fast-layer runner test runs against the memory store, proving the contract is the
 * port's and not the medium's.
 */

const OWNER = 'local';
const OTHER = 'someone-else';

let store: JobStore;

beforeEach(() => {
  store = openSqliteJobStore({ filename: ':memory:' });
});

afterEach(() => {
  store.close();
});

function aDocument(): OmrDocument {
  return {
    schemaVersion: OMR_SCHEMA_VERSION,
    source: {
      engine: 'oemer',
      engineVersion: '0.1.8',
      imagePath: 'page-1',
      imageWidth: 100,
      imageHeight: 200,
      provider: 'CPUExecutionProvider',
      wallClockSeconds: 1,
    },
    staves: [],
    zones: [],
    noteheads: [],
    noteGroups: [],
    barlines: [],
    rests: [],
  };
}

describe('the SQLite job store', () => {
  it('creates a queued job and reads it back in full', () => {
    const created = store.create(OWNER, ['img-0']);
    expect(created.status).toBe('queued');
    expect(created.attempts).toBe(0);
    expect(created.imageKeys).toEqual(['img-0']);
    expect(created.result).toBeNull();

    const got = store.get(OWNER, created.id);
    expect(got).toEqual(created);
  });

  it('refuses a job with no images', () => {
    expect(() => store.create(OWNER, [])).toThrow(/at least one image/);
  });

  it('scopes reads to the owner (ADR-0001)', () => {
    const job = store.create(OWNER, ['img-0']);
    expect(store.get(OTHER, job.id)).toBeNull();
    expect(store.list(OTHER)).toEqual([]);
  });

  it('lists jobs newest first, without their results', () => {
    let clock = 0;
    const timed = openSqliteJobStore({ filename: ':memory:', now: () => new Date(1_700_000_000_000 + clock++ * 1000) });
    const a = timed.create(OWNER, ['a']);
    const b = timed.create(OWNER, ['b']);
    const list = timed.list(OWNER);
    expect(list.map((j) => j.id)).toEqual([b.id, a.id]);
    // A summary has no `result` key at all.
    expect('result' in list[0]!).toBe(false);
    timed.close();
  });

  it('claims the oldest queued job into running, one at a time', () => {
    let clock = 0;
    const timed = openSqliteJobStore({ filename: ':memory:', now: () => new Date(1_700_000_000_000 + clock++ * 1000) });
    const first = timed.create(OWNER, ['a']);
    timed.create(OWNER, ['b']);

    const claimed = timed.claim();
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(1);
    timed.close();
  });

  it('returns null from claim when nothing is queued', () => {
    expect(store.claim()).toBeNull();
    const job = store.create(OWNER, ['a']);
    store.claim(); // takes it to running
    expect(store.get(OWNER, job.id)?.status).toBe('running');
    expect(store.claim()).toBeNull(); // nothing queued now
  });

  it('completes a running job with its result and the score it produced', () => {
    const job = store.create(OWNER, ['a']);
    store.claim();
    const done = store.complete(job.id, [aDocument()], 'import-42');
    expect(done?.status).toBe('succeeded');
    expect(store.get(OWNER, job.id)?.result).toEqual([aDocument()]);
    expect(store.get(OWNER, job.id)?.scoreId).toBe('import-42');
  });

  it('will not complete or fail a job that is not running', () => {
    const job = store.create(OWNER, ['a']); // still queued
    expect(store.complete(job.id, [aDocument()], 'import-42')).toBeNull();
    expect(store.fail(job.id, 'nope')).toBeNull();
    expect(store.get(OWNER, job.id)?.status).toBe('queued');
  });

  it('fails a running job with a diagnostic and retries it (Q80)', () => {
    const job = store.create(OWNER, ['a']);
    store.claim();
    const failed = store.fail(job.id, 'worker down');
    expect(failed?.status).toBe('failed');
    expect(failed?.diagnostic).toBe('worker down');

    const requeued = store.retry(OWNER, job.id);
    expect(requeued?.status).toBe('queued');
    expect(requeued?.diagnostic).toBeNull();

    // A second run: claim increments attempts again.
    const claimed = store.claim();
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.attempts).toBe(2);
  });

  it('only retries a failed job, and only for its owner', () => {
    const job = store.create(OWNER, ['a']); // queued, not failed
    expect(store.retry(OWNER, job.id)).toBeNull();
    store.claim();
    store.fail(job.id, 'x');
    expect(store.retry(OTHER, job.id)).toBeNull(); // not this owner's
    expect(store.retry(OWNER, job.id)?.status).toBe('queued');
  });

  it('recovers jobs left running across a restart (ADR-0001 #7)', () => {
    const a = store.create(OWNER, ['a']);
    const b = store.create(OWNER, ['b']);
    store.claim(); // a -> running
    store.claim(); // b -> running
    const recovered = store.recover('interrupted');
    expect(recovered).toBe(2);
    expect(store.get(OWNER, a.id)?.status).toBe('failed');
    expect(store.get(OWNER, b.id)?.diagnostic).toBe('interrupted');
  });

  it('persists jobs across a reopen of the same database', () => {
    // A file-backed store, closed and reopened, still has its jobs — the point of durable state.
    const file = `/tmp/sbscore-jobs-${process.pid}-${Date.now()}.db`;
    const first = openSqliteJobStore({ filename: file });
    const job = first.create(OWNER, ['a']);
    first.close();

    const second = openSqliteJobStore({ filename: file });
    expect(second.get(OWNER, job.id)?.status).toBe('queued');
    second.close();
  });
});
