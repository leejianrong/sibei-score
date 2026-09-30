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

beforeEach(async () => {
  store = openSqliteJobStore({ filename: ':memory:' });
});

afterEach(async () => {
  await store.close();
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
    bandTokens: [],
  };
}

describe('the SQLite job store', () => {
  it('creates a queued job and reads it back in full', async () => {
    const created = await store.create(OWNER, ['img-0']);
    expect(created.status).toBe('queued');
    expect(created.attempts).toBe(0);
    expect(created.imageKeys).toEqual(['img-0']);
    expect(created.result).toBeNull();

    const got = await store.get(OWNER, created.id);
    expect(got).toEqual(created);
  });

  it('refuses a job with no images', async () => {
    await expect(store.create(OWNER, [])).rejects.toThrow(/at least one image/);
  });

  it('scopes reads to the owner (ADR-0001)', async () => {
    const job = await store.create(OWNER, ['img-0']);
    expect(await store.get(OTHER, job.id)).toBeNull();
    expect(await store.list(OTHER)).toEqual([]);
  });

  it('lists jobs newest first, without their results', async () => {
    let clock = 0;
    const timed = openSqliteJobStore({ filename: ':memory:', now: () => new Date(1_700_000_000_000 + clock++ * 1000) });
    const a = await timed.create(OWNER, ['a']);
    const b = await timed.create(OWNER, ['b']);
    const list = await timed.list(OWNER);
    expect(list.map((j) => j.id)).toEqual([b.id, a.id]);
    // A summary has no `result` key at all.
    expect('result' in list[0]!).toBe(false);
    await timed.close();
  });

  it('claims the oldest queued job into running, one at a time', async () => {
    let clock = 0;
    const timed = openSqliteJobStore({ filename: ':memory:', now: () => new Date(1_700_000_000_000 + clock++ * 1000) });
    const first = await timed.create(OWNER, ['a']);
    await timed.create(OWNER, ['b']);

    const claimed = await timed.claim();
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(1);
    await timed.close();
  });

  it('returns null from claim when nothing is queued', async () => {
    expect(await store.claim()).toBeNull();
    const job = await store.create(OWNER, ['a']);
    await store.claim(); // takes it to running
    expect((await store.get(OWNER, job.id))?.status).toBe('running');
    expect(await store.claim()).toBeNull(); // nothing queued now
  });

  it('completes a running job with its result and the score it produced', async () => {
    const job = await store.create(OWNER, ['a']);
    await store.claim();
    const done = await store.complete(job.id, [aDocument()], 'import-42');
    expect(done?.status).toBe('succeeded');
    expect((await store.get(OWNER, job.id))?.result).toEqual([aDocument()]);
    expect((await store.get(OWNER, job.id))?.scoreId).toBe('import-42');
  });

  it('will not complete or fail a job that is not running', async () => {
    const job = await store.create(OWNER, ['a']); // still queued
    expect(await store.complete(job.id, [aDocument()], 'import-42')).toBeNull();
    expect(await store.fail(job.id, 'nope')).toBeNull();
    expect((await store.get(OWNER, job.id))?.status).toBe('queued');
  });

  it('fails a running job with a diagnostic and retries it (Q80)', async () => {
    const job = await store.create(OWNER, ['a']);
    await store.claim();
    const failed = await store.fail(job.id, 'worker down');
    expect(failed?.status).toBe('failed');
    expect(failed?.diagnostic).toBe('worker down');

    const requeued = await store.retry(OWNER, job.id);
    expect(requeued?.status).toBe('queued');
    expect(requeued?.diagnostic).toBeNull();

    // A second run: claim increments attempts again.
    const claimed = await store.claim();
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.attempts).toBe(2);
  });

  it('only retries a failed job, and only for its owner', async () => {
    const job = await store.create(OWNER, ['a']); // queued, not failed
    expect(await store.retry(OWNER, job.id)).toBeNull();
    await store.claim();
    await store.fail(job.id, 'x');
    expect(await store.retry(OTHER, job.id)).toBeNull(); // not this owner's
    expect((await store.retry(OWNER, job.id))?.status).toBe('queued');
  });

  it('recovers jobs left running across a restart (ADR-0001 #7)', async () => {
    const a = await store.create(OWNER, ['a']);
    const b = await store.create(OWNER, ['b']);
    await store.claim(); // a -> running
    await store.claim(); // b -> running
    const recovered = await store.recover('interrupted');
    expect(recovered).toBe(2);
    expect((await store.get(OWNER, a.id))?.status).toBe('failed');
    expect((await store.get(OWNER, b.id))?.diagnostic).toBe('interrupted');
  });

  it('finds the job that produced a score, scoped to its owner (V14)', async () => {
    // The reverse of `scoreId`: a re-parse (V14) opens with a score and reaches back to the job that
    // imported it, for the source images it retained (ADR-0019).
    const job = await store.create(OWNER, ['a']);
    await store.claim();
    await store.complete(job.id, [aDocument()], 'import-42');

    const found = await store.getByScoreId(OWNER, 'import-42');
    expect(found?.id).toBe(job.id);
    expect(found?.scoreId).toBe('import-42');
    // The full job, not a summary — it carries the recognised result.
    expect(found?.result).toEqual([aDocument()]);

    // Not another owner's, and not a score no import produced (a queued job has a null scoreId).
    expect(await store.getByScoreId(OTHER, 'import-42')).toBeNull();
    expect(await store.getByScoreId(OWNER, 'no-such-score')).toBeNull();
    await store.create(OWNER, ['b']); // still queued, scoreId null — never matches a lookup
    expect(await store.getByScoreId(OWNER, 'import-99')).toBeNull();
  });

  it('records and reads back the engine a re-parse chose (V14e), null by default', async () => {
    const plain = await store.create(OWNER, ['a']);
    expect(plain.engine).toBeNull();
    expect((await store.get(OWNER, plain.id))?.engine).toBeNull();

    const chosen = await store.create(OWNER, ['b'], 'heuristic');
    expect(chosen.engine).toBe('heuristic');
    expect((await store.get(OWNER, chosen.id))?.engine).toBe('heuristic');
    // The listing summary carries it too.
    expect((await store.list(OWNER)).find((j) => j.id === chosen.id)?.engine).toBe('heuristic');
  });

  it('persists jobs across a reopen of the same database', async () => {
    // A file-backed store, closed and reopened, still has its jobs — the point of durable state.
    const file = `/tmp/sbscore-jobs-${process.pid}-${Date.now()}.db`;
    const first = openSqliteJobStore({ filename: file });
    const job = await first.create(OWNER, ['a']);
    await first.close();

    const second = openSqliteJobStore({ filename: file });
    expect((await second.get(OWNER, job.id))?.status).toBe('queued');
    await second.close();
  });
});
