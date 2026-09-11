import { afterEach, describe, expect, it } from 'vitest';
import { createApi, silentLogger } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Api, ScoreStore } from '@sibei/api';

/**
 * The bind-host parameter (V8h, the ADR-0029 amendment).
 *
 * The default is loopback and every other caller in the suite relies on it by omitting `host`; these
 * tests pin the two things the amendment actually changed: that an explicit host is honoured, and
 * that `0.0.0.0` — which the container passes — still answers on loopback, so the compose file's
 * `127.0.0.1:PORT:PORT` publish can reach it. Real sockets, because a bind address is precisely the
 * thing a mocked listen would not exercise.
 */

let store: ScoreStore;
let api: Api;

afterEach(async () => {
  await api.close();
  store.close();
});

function serve(): Api {
  store = openSqliteStore({ filename: ':memory:' });
  api = createApi({ store, logger: silentLogger });
  return api;
}

async function healthOk(port: number): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/health`);
  return response.ok;
}

it('defaults to loopback when no host is given — reachable on 127.0.0.1', async () => {
  const { port } = await serve().listen(0);
  expect(port).toBeGreaterThan(0);
  expect(await healthOk(port)).toBe(true);
});

it('honours an explicit loopback host', async () => {
  const { port } = await serve().listen(0, '127.0.0.1');
  expect(await healthOk(port)).toBe(true);
});

it('binds 0.0.0.0 (the container case) and still answers on loopback', async () => {
  // This is the whole point of the amendment: the container binds all interfaces so Docker's
  // forwarded port reaches it, and 0.0.0.0 includes loopback, so a request to 127.0.0.1 — which is
  // what the loopback publish forwards — is served.
  const { port } = await serve().listen(0, '0.0.0.0');
  expect(await healthOk(port)).toBe(true);
});
