import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createApi, createLimits, silentLogger } from '@sibei/api';
import type { Api, ChangeEvent, ScoreStore } from '@sibei/api';
import { openRedis } from '@sibei/api/redis';
import type { RedisServices } from '@sibei/api/redis';
import { openSqliteStore } from '@sibei/api/sqlite';

/**
 * The Redis adapter against a real Redis (V23). Each "process" is its own `openRedis` (its own pair of
 * connections and its own process id on the wire), which is exactly what a second API process is to Redis.
 *
 * `SBSCORE_TEST_REDIS_URL` names the server; a missing one is an error, never a skip, for the reason
 * `tests/postgres/support.ts` gives.
 */

const URL_ = process.env.SBSCORE_TEST_REDIS_URL;
if (URL_ === undefined || URL_ === '') throw new Error('SBSCORE_TEST_REDIS_URL is not set; run `pnpm test:redis`');

const opened: RedisServices[] = [];
const apis: Api[] = [];
const stores: ScoreStore[] = [];

async function process_(): Promise<RedisServices> {
  const services = await openRedis({ url: URL_!, onError: (message, error) => { throw new Error(`${message}: ${String(error)}`); } });
  opened.push(services);
  return services;
}

afterEach(async () => {
  for (const api of apis.splice(0)) await api.close();
  for (const store of stores.splice(0)) await store.close();
  for (const services of opened.splice(0)) await services.close();
});

const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('the change bus across processes', () => {
  it('delivers a publish on one process to a subscriber on another, and to its own exactly once', async () => {
    const a = (await process_()).changeBus();
    const b = (await process_()).changeBus();
    const onA: ChangeEvent[] = [];
    const onB: ChangeEvent[] = [];
    a.subscribe('usr_1', 's1', (e) => onA.push(e));
    b.subscribe('usr_1', 's1', (e) => onB.push(e));
    await settle();
    a.publish('usr_1', { kind: 'changed', scoreId: 's1', version: 7 });
    await settle();
    expect(onB).toEqual([{ kind: 'changed', scoreId: 's1', version: 7 }]);
    expect(onA).toEqual([{ kind: 'changed', scoreId: 's1', version: 7 }]);
  });

  it('keeps owners apart across processes', async () => {
    const a = (await process_()).changeBus();
    const b = (await process_()).changeBus();
    const heard: ChangeEvent[] = [];
    b.subscribe('usr_2', 's1', (e) => heard.push(e));
    await settle();
    a.publish('usr_1', { kind: 'changed', scoreId: 's1', version: 1 });
    await settle();
    expect(heard).toEqual([]);
  });

  it('carries job moves too', async () => {
    const a = (await process_()).jobBus();
    const b = (await process_()).jobBus();
    const heard: unknown[] = [];
    b.subscribe('usr_1', 'job1', (e) => heard.push(e));
    await settle();
    a.publish('usr_1', { jobId: 'job1', status: 'succeeded' });
    await settle();
    expect(heard).toEqual([{ jobId: 'job1', status: 'succeeded' }]);
  });
});

describe('two API processes', () => {
  it('repaint an SSE client on one from an edit made through the other', async () => {
    // One library, two API servers with their own buses joined only by Redis.
    const store = openSqliteStore({ filename: ':memory:' });
    stores.push(store);
    const make = async (): Promise<string> => {
      const redis = await process_();
      const api = createApi({ store, logger: silentLogger, changeBus: redis.changeBus(), jobBus: redis.jobBus() });
      apis.push(api);
      return `http://127.0.0.1:${(await api.listen(0)).port}`;
    };
    const first = await make();
    const second = await make();

    await fetch(`${first}/v1/scores`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: { type: 'score.create', payload: { id: 'x', barCount: 4, title: 'X' } } }),
    });

    const stream = await fetch(`${second}/v1/scores/x/events`);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const until = async (pattern: RegExp): Promise<void> => {
      const deadline = Date.now() + 5000;
      while (!pattern.test(text)) {
        if (Date.now() > deadline) throw new Error(`timed out; saw ${JSON.stringify(text)}`);
        const { value, done } = await reader.read();
        if (done) throw new Error('the stream ended');
        text += decoder.decode(value);
      }
    };
    await until(/"version":1/); // the catch-up frame
    await settle();

    const version = ((await (await fetch(`${first}/v1/scores/x`)).json()) as { version: number }).version;
    const edit = await fetch(`${first}/v1/scores/x/ops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: { type: 'meta.set', payload: { title: 'Renamed' } }, expectedVersion: version }),
    });
    expect(edit.status).toBe(200);
    await until(new RegExp(`"version":${version + 1}`));
    await reader.cancel();
  });
});

describe('the shared rate limiter', () => {
  it('counts one budget across two processes', async () => {
    const key = `test:${randomUUID()}`;
    const a = (await process_()).limiter;
    const b = (await process_()).limiter;
    expect((await a.consume(key, 1, 2, 5000)).allowed).toBe(true);
    expect((await b.consume(key, 1, 2, 5000)).allowed).toBe(true);
    const refused = await a.consume(key, 1, 2, 5000);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(5000);
  });

  it('refuses a cost that does not fit without counting it, and expires with its window', async () => {
    const key = `test:${randomUUID()}`;
    const limiter = (await process_()).limiter;
    expect((await limiter.consume(key, 3, 5, 300)).allowed).toBe(true);
    expect((await limiter.consume(key, 3, 5, 300)).allowed).toBe(false);
    expect((await limiter.consume(key, 2, 5, 300)).remaining).toBe(0);
    await settle(400);
    expect((await limiter.consume(key, 5, 5, 300)).allowed).toBe(true);
  });

  it('is what the limits use, so a per-user quota is shared across replicas', async () => {
    const user = `usr_${randomUUID()}`;
    const config = { ...(await import('@sibei/api')).DEFAULT_LIMITS, quotas: { ...(await import('@sibei/api')).DEFAULT_LIMITS.quotas, importPagesPerDay: 3 } };
    const one = createLimits({ config, limiter: (await process_()).limiter });
    const two = createLimits({ config, limiter: (await process_()).limiter });
    await one.spendImport(user, 2, 1);
    await expect(two.spendImport(user, 2, 1)).rejects.toMatchObject({ quota: 'import-pages' });
  });
});
