import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, silentLogger } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Api, ScoreStore } from '@sibei/api';
import { barViews, dur } from '@sibei/model';
import type { Score } from '@sibei/model';

/**
 * `POST /v1/scores/:id/group` over real HTTP and a real store (SIB2-282, the ADR-0003 amendment): fold the last n batches
 * into one undoable unit, so a burst of keystrokes undoes (and redoes) in one step. Same guards as undo: a version is
 * required and a stale one is a 409; the floor (the create batch) is never absorbed.
 */

let store: ScoreStore;
let api: Api;
let base: string;

beforeEach(async () => {
  store = openSqliteStore({ filename: ':memory:' });
  api = createApi({ store, logger: silentLogger });
  const { port } = await api.listen(0);
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await api.close();
  await store.close();
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

const version = async (): Promise<number> => (await call('GET', '/v1/scores/g-1')).body.version as number;
const count = async (): Promise<number> =>
  barViews((await call('GET', '/v1/scores/g-1')).body.score as Score).reduce((n, bar) => n + bar.items.length, 0);

async function addNotes(howMany: number): Promise<void> {
  for (let beat = 1; beat <= howMany; beat += 1) {
    const reply = await call('POST', '/v1/scores/g-1/ops', {
      operation: { type: 'note.add', target: `bar1.beat${beat}`, payload: { pitch: 'C5', duration: dur(4) } },
      expectedVersion: await version(),
    });
    expect(reply.status).toBe(200);
  }
}

beforeEach(async () => {
  await call('POST', '/v1/scores', { operation: { type: 'score.create', payload: { id: 'g-1', barCount: 4 } } });
});

describe('group over HTTP (SIB2-282)', () => {
  it('turns four one-note batches into one undo, and one redo', async () => {
    await addNotes(4);
    const before = await version();
    const grouped = await call('POST', '/v1/scores/g-1/group', { count: 4, expectedVersion: before });
    expect(grouped.status).toBe(200);
    expect(grouped.body).toMatchObject({ moved: true, canUndo: true, canRedo: false, version: before + 1 });
    expect(await count()).toBe(4);

    const undone = await call('POST', '/v1/scores/g-1/undo', { expectedVersion: await version() });
    expect(undone.body).toMatchObject({ moved: true, canUndo: false });
    expect(await count()).toBe(0);

    const redone = await call('POST', '/v1/scores/g-1/redo', { expectedVersion: await version() });
    expect(redone.body).toMatchObject({ moved: true, canRedo: false });
    expect(await count()).toBe(4);
  });

  it('without a group, each note still undoes on its own', async () => {
    await addNotes(3);
    await call('POST', '/v1/scores/g-1/undo', { expectedVersion: await version() });
    expect(await count()).toBe(2);
  });

  it('groups only the last n: what came before is its own unit', async () => {
    await addNotes(4);
    await call('POST', '/v1/scores/g-1/group', { count: 3, expectedVersion: await version() });
    await call('POST', '/v1/scores/g-1/undo', { expectedVersion: await version() });
    expect(await count()).toBe(1);
  });

  it('is a 409 when anything landed since the version the caller holds', async () => {
    await addNotes(3);
    const stale = await version();
    await addNotes(0);
    await call('POST', '/v1/scores/g-1/ops', {
      operation: { type: 'note.add', target: 'bar2.beat1', payload: { pitch: 'D5', duration: dur(4) } },
      expectedVersion: stale,
    });
    const reply = await call('POST', '/v1/scores/g-1/group', { count: 3, expectedVersion: stale });
    expect(reply.status).toBe(409);
    expect(reply.body.error).toMatchObject({ kind: 'stale-version' });
  });

  it('refuses no version, a count under 2, and a count that would absorb the create batch', async () => {
    await addNotes(2);
    const current = await version();
    expect((await call('POST', '/v1/scores/g-1/group', { count: 2 })).status).toBe(422);
    const tooSmall = await call('POST', '/v1/scores/g-1/group', { count: 1, expectedVersion: current });
    expect(tooSmall.status).toBe(422);
    expect((tooSmall.body.error as { kind: string }).kind).toBe('validation');
    const tooMany = await call('POST', '/v1/scores/g-1/group', { count: 3, expectedVersion: current });
    expect(tooMany.status).toBe(422);
    expect(await version()).toBe(current);
  });

  it('is a 404 for a chart that is not there and a 405 for a GET', async () => {
    expect((await call('POST', '/v1/scores/nope/group', { count: 2, expectedVersion: 1 })).status).toBe(404);
    expect((await call('GET', '/v1/scores/g-1/group')).status).toBe(405);
  });
});
