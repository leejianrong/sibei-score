import { afterEach, describe, expect, it } from 'vitest';
import { createApi, silentLogger } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Api, AssetSource, ScoreStore } from '@sibei/api';

/**
 * Serving the built UI from the API (V8g), over real HTTP against a real store.
 *
 * The bytes arrive through an injected `AssetSource` — no filesystem, because ADR-0006 keeps `fs`
 * out of `packages/api` and the fs-backed reader is `packages/cli`'s (`static-assets.ts`, covered
 * in `tests/cli`). What this file pins is the *routing*: that a file is served only where no `/v1/`
 * route claimed the path, only for a GET, and never over the API surface.
 */

const INDEX = new TextEncoder().encode('<!doctype html><title>sbscore</title>');
const APP_JS = new TextEncoder().encode('console.log("app")');

/** A fake bundle: `/` and `/index.html` are the page, `/assets/app.js` the script. */
const BUNDLE: AssetSource = {
  asset(path) {
    if (path === '/' || path === '/index.html') {
      return { bytes: INDEX, contentType: 'text/html; charset=utf-8' };
    }
    if (path === '/assets/app.js') {
      return { bytes: APP_JS, contentType: 'text/javascript; charset=utf-8' };
    }
    // Deliberately *would* answer a `/v1/` path, to prove the route guard never consults it there.
    if (path === '/v1/health') return { bytes: INDEX, contentType: 'text/html; charset=utf-8' };
    return null;
  },
};

let store: ScoreStore;
let api: Api;
let base: string;

async function serveWith(assets: AssetSource | undefined): Promise<void> {
  store = openSqliteStore({ filename: ':memory:' });
  api = createApi({
    store,
    logger: silentLogger,
    ...(assets === undefined ? {} : { assets }),
  });
  const { port } = await api.listen(0);
  base = `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await api.close();
  store.close();
});

async function get(path: string): Promise<{ status: number; type: string | null; text: string }> {
  const response = await fetch(`${base}${path}`);
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    text: await response.text(),
  };
}

describe('with a UI bundle', () => {
  it('serves the index at /', async () => {
    await serveWith(BUNDLE);
    const reply = await get('/');
    expect(reply.status).toBe(200);
    expect(reply.type).toBe('text/html; charset=utf-8');
    expect(reply.text).toContain('<title>sbscore</title>');
  });

  it('serves a hashed asset by its own path', async () => {
    await serveWith(BUNDLE);
    const reply = await get('/assets/app.js');
    expect(reply.status).toBe(200);
    expect(reply.type).toBe('text/javascript; charset=utf-8');
    expect(reply.text).toBe('console.log("app")');
  });

  it('sends nosniff, the same as the JSON and PDF responses', async () => {
    await serveWith(BUNDLE);
    const response = await fetch(`${base}/`);
    await response.text();
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('404s a path the bundle has no file for, rather than serving the index', async () => {
    // No SPA fallback: the browser routes on the hash, so a real path miss is a genuine 404.
    await serveWith(BUNDLE);
    const reply = await get('/library');
    expect(reply.status).toBe(404);
    expect(reply.text).toContain('no-such-route');
  });

  it('never lets a file shadow the API, even when the bundle would answer the path', async () => {
    // The fake answers `/v1/health`; the real health route must win, because static is tried after
    // routing and never for a `/v1/` path.
    await serveWith(BUNDLE);
    const reply = await get('/v1/health');
    expect(reply.status).toBe(200);
    expect(reply.type).toBe('application/json; charset=utf-8');
    expect(JSON.parse(reply.text)).toEqual({ status: 'ok', api: 'v1' });
  });

  it('leaves an unknown /v1/ path a 404 API miss, not a served file', async () => {
    await serveWith(BUNDLE);
    const reply = await get('/v1/nope');
    expect(reply.status).toBe(404);
    expect(reply.text).toContain('no-such-route');
  });

  it('only serves a GET; a POST to a static path falls through to 404', async () => {
    await serveWith(BUNDLE);
    const response = await fetch(`${base}/`, { method: 'POST' });
    expect(response.status).toBe(404);
  });
});

describe('without a UI bundle (the development default)', () => {
  it('404s / the way it always did', async () => {
    await serveWith(undefined);
    const reply = await get('/');
    expect(reply.status).toBe(404);
    expect(reply.text).toContain('no-such-route');
  });
});
