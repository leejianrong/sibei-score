import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, createApi, createLimits, silentLogger } from '@sibei/api';
import type { Api, LimitsConfig, ScoreStore } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';

/**
 * Rate limits, quotas and the widened guards, over a real socket (V23, ADR-0034 decisions 7 and 8).
 * The server runs in local mode with limits switched on, which is enough to exercise the gates; the
 * hosted sign-in has its own suite.
 */

let api: Api | undefined;
let store: ScoreStore | undefined;
let base = '';

async function start(config: Partial<LimitsConfig> & { quotas?: Partial<LimitsConfig['quotas']> }, extra: { allowedHosts?: string[] } = {}): Promise<void> {
  store = openSqliteStore({ filename: ':memory:' });
  const merged: LimitsConfig = { ...DEFAULT_LIMITS, ...config, quotas: { ...DEFAULT_LIMITS.quotas, ...config.quotas } };
  api = createApi({ store, logger: silentLogger, limits: createLimits({ config: merged }), ...extra });
  const { port } = await api.listen(0);
  base = `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await api?.close();
  await store?.close();
  api = undefined;
  store = undefined;
});

const create = (id: string): Promise<Response> =>
  fetch(`${base}/v1/scores`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation: { type: 'score.create', payload: { id, barCount: 4, title: id } } }),
  });

describe('rate limits', () => {
  it('answer 429 as a structured problem with Retry-After', async () => {
    await start({ ip: { limit: 2, windowMs: 60_000 } });
    expect((await fetch(`${base}/v1/scores`)).status).toBe(200);
    expect((await fetch(`${base}/v1/scores`)).status).toBe(200);
    const refused = await fetch(`${base}/v1/scores`);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    const { error } = (await refused.json()) as { error: { kind: string; detail: { scope: string; limit: number; retryAfterSeconds: number } } };
    expect(error.kind).toBe('rate-limited');
    expect(error.detail).toMatchObject({ scope: 'ip', limit: 2 });
    // the health check is never limited
    expect((await fetch(`${base}/v1/health`)).status).toBe(200);
  });

  it('limit a user by class: reads stay open while writes are spent', async () => {
    await start({ rates: { ...DEFAULT_LIMITS.rates, write: { limit: 1, windowMs: 60_000 } } });
    expect((await create('a')).status).toBe(201);
    const refused = await create('b');
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { detail: { class: string } } }).error.detail.class).toBe('write');
    expect((await fetch(`${base}/v1/scores`)).status).toBe(200);
  });
});

describe('quotas', () => {
  it('refuse a score past the account limit with a structured 403, and free the room on delete', async () => {
    await start({ quotas: { ...DEFAULT_LIMITS.quotas, maxScores: 1 } });
    expect((await create('one')).status).toBe(201);
    const refused = await create('two');
    expect(refused.status).toBe(403);
    const { error } = (await refused.json()) as { error: { kind: string; detail: { quota: string; limit: number } } };
    expect(error.kind).toBe('quota-exceeded');
    expect(error.detail).toEqual({ quota: 'scores', limit: 1 });
    // a duplicate is a new score too
    expect((await fetch(`${base}/v1/scores/one/duplicate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${base}/v1/scores/one`, { method: 'DELETE' })).status).toBe(204);
    expect((await create('two')).status).toBe(201);
  });

  it('cap concurrent event streams per user and free the slot when one closes', async () => {
    await start({ quotas: { ...DEFAULT_LIMITS.quotas, maxStreams: 1 } });
    await create('one');
    const first = new AbortController();
    const open = await fetch(`${base}/v1/scores/one/events`, { signal: first.signal });
    expect(open.status).toBe(200);
    const refused = await fetch(`${base}/v1/scores/one/events`);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { kind: string } }).error.kind).toBe('quota-exceeded');
    first.abort();
    // the close reaches the server asynchronously
    let reopened = 0;
    for (let i = 0; i < 40 && reopened !== 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const again = new AbortController();
      const response = await fetch(`${base}/v1/scores/one/events`, { signal: again.signal });
      reopened = response.status;
      again.abort();
    }
    expect(reopened).toBe(200);
  });
});

describe('the guards, widened and not loosened', () => {
  it('still refuse a foreign Origin on a write and add no CORS headers', async () => {
    await start({});
    const refused = await fetch(`${base}/v1/scores`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: '{}',
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { kind: string } }).error.kind).toBe('foreign-origin');
    const ok = await fetch(`${base}/v1/scores`, { headers: { origin: 'https://evil.example' } });
    expect([...ok.headers.keys()].filter((name) => name.startsWith('access-control-'))).toEqual([]);
  });

  it('admit a configured extra host and nothing else', async () => {
    await start({}, { allowedHosts: ['Sibei.Example'] });
    const via = (host: string, origin?: string): Promise<number> =>
      new Promise((resolve, reject) => {
        import('node:http').then(({ request }) => {
          const req = request(
            { host: '127.0.0.1', port: Number(new URL(base).port), path: '/v1/scores', method: 'GET', setHost: false, headers: { host, ...(origin === undefined ? {} : { origin }) } },
            (response) => {
              response.resume();
              resolve(response.statusCode ?? 0);
            },
          );
          req.on('error', reject);
          req.end();
        }, reject);
      });
    expect(await via('sibei.example')).toBe(200);
    expect(await via('other.example')).toBe(403);
  });
});
