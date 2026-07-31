import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, openSqliteStore, silentLogger } from '@sibei/api';
import type { Api, Operation, ScoreStore } from '@sibei/api';
import { dur } from '@sibei/model';

/**
 * The `/v1/` API, over real HTTP against a real store.
 *
 * PLAN.md calls this the highest-value seam in the project, because both surfaces go through it and
 * it is where "the UI and the CLI cannot disagree" is either true or false. So these are real
 * requests to a real listening socket — not the handler called directly, which would skip the very
 * guards ADR-0029 is about.
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
  store.close();
});

interface Reply {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

/** A request the way the CLI makes one: no Origin header, because it is not a browser. */
async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    headers: response.headers,
  };
}

/**
 * A raw request, for the one header `fetch` will not let us set.
 *
 * `Host` is a forbidden header name in the fetch spec, so `fetch` silently drops an override — the
 * first version of the Host tests used it and passed against a header that never left the process,
 * which is exactly the shape of a guard that only looks tested.
 */
function raw(
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port: Number(port), path, method, headers, setHost: false },
      (response) => {
        let text = '';
        response.on('data', (chunk) => (text += String(chunk)));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

const CREATE: Operation = {
  type: 'score.create',
  payload: { id: 'score-1', barCount: 4, title: 'Body and Soul' },
};

const note = (target: string, pitch: string): Operation => ({
  type: 'note.add',
  target,
  payload: { pitch, duration: dur(4) },
});

async function aChart(): Promise<number> {
  await call('POST', '/v1/scores', { operation: CREATE });
  const reply = await call('POST', '/v1/scores/score-1/ops', { operation: note('bar1.beat1', 'Eb5') });
  return reply.body.version as number;
}

describe('health', () => {
  it('says it is up, and says nothing about the host', () => {
    // "You cannot call it shipped if you cannot see it running." And a health endpoint that leaks
    // a store path or a port would be a worse trade than not having one (ADR-0029).
    return call('GET', '/v1/health').then((reply) => {
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ status: 'ok', api: 'v1' });
    });
  });
});

describe('the library', () => {
  it('lists nothing to start with', async () => {
    expect(await call('GET', '/v1/scores')).toMatchObject({ status: 200, body: { scores: [] } });
  });

  it('creates a score and points at it', async () => {
    const reply = await call('POST', '/v1/scores', { operation: CREATE });
    expect(reply.status).toBe(201);
    expect(reply.headers.get('location')).toBe('/v1/scores/score-1');
    expect(reply.body).toMatchObject({ scoreId: 'score-1', version: 1, changed: ['score-1'] });
  });

  it('lists it afterwards, from the extracted columns', async () => {
    await call('POST', '/v1/scores', { operation: CREATE });
    const reply = await call('GET', '/v1/scores');
    expect(reply.body.scores).toMatchObject([{ id: 'score-1', title: 'Body and Soul', version: 1 }]);
  });

  it('reads the whole document with its version', async () => {
    await aChart();
    const reply = await call('GET', '/v1/scores/score-1');
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ version: 2 });
    expect((reply.body.score as { bars: unknown[] }).bars).toHaveLength(4);
  });

  it('deletes', async () => {
    await aChart();
    expect((await call('DELETE', '/v1/scores/score-1')).status).toBe(204);
    expect((await call('GET', '/v1/scores/score-1')).status).toBe(404);
  });

  it('404s a read, a delete and an ops post for a score that is not there', async () => {
    expect((await call('GET', '/v1/scores/nope')).status).toBe(404);
    expect((await call('DELETE', '/v1/scores/nope')).status).toBe(404);
    const reply = await call('POST', '/v1/scores/nope/ops', { operation: note('bar1.beat1', 'C5') });
    expect(reply.status).toBe(404);
    expect((reply.body.error as { kind: string }).kind).toBe('no-such-score');
  });

  it('409s a create whose id is taken', async () => {
    await call('POST', '/v1/scores', { operation: CREATE });
    const reply = await call('POST', '/v1/scores', { operation: CREATE });
    expect(reply.status).toBe(409);
    expect((reply.body.error as { kind: string }).kind).toBe('conflict-exists');
  });
});

describe('a stale write is 409 with the current version (ADR-0003)', () => {
  it('carries the version to retry at, rather than leaving the client to guess', async () => {
    const version = await aChart();

    const ok = await call('POST', '/v1/scores/score-1/ops', {
      operation: note('bar1.beat2', 'F5'),
      expectedVersion: version,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(version + 1);

    // A second client that read at the same moment and is now one behind.
    const stale = await call('POST', '/v1/scores/score-1/ops', {
      operation: note('bar1.beat3', 'G5'),
      expectedVersion: version,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({
      kind: 'stale-version',
      currentVersion: version + 1,
      detail: { kind: 'stale-version', expected: version, current: version + 1 },
    });
  });

  it('leaves the score untouched', async () => {
    const version = await aChart();
    const before = await call('GET', '/v1/scores/score-1');

    await call('POST', '/v1/scores/score-1/ops', {
      operation: note('bar1.beat2', 'F5'),
      expectedVersion: version - 1,
    });

    const after = await call('GET', '/v1/scores/score-1');
    expect(after.body).toEqual(before.body);
  });
});

describe('errors are machine-readable (ADR-0008)', () => {
  it('422s a bad address and brings the bar’s real onsets with it', async () => {
    await aChart();
    const reply = await call('POST', '/v1/scores/score-1/ops', {
      operation: { type: 'note.set', target: 'bar1.beat3', payload: { pitch: 'C5' } },
    });
    expect(reply.status).toBe(422);
    expect(reply.body.error).toMatchObject({
      kind: 'address',
      message: 'bar 1 has no note at beat 3; onsets are 1',
      // The structure, so an agent does not have to parse the prose to find the onsets.
      detail: { failure: { kind: 'not-an-onset', bar: 1, beat: 3, onsets: [1], looking: 'note' } },
    });
  });

  it('422s a validation failure', async () => {
    await aChart();
    const reply = await call('POST', '/v1/scores/score-1/ops', {
      operation: note('bar1.beat2', 'H9'),
    });
    expect(reply.status).toBe(422);
    expect(reply.body.error).toMatchObject({ kind: 'validation' });
  });

  it('422s a verb it does not know, by name', async () => {
    await aChart();
    const reply = await call('POST', '/v1/scores/score-1/ops', {
      operation: { type: 'note.transmogrify' } as unknown as Operation,
    });
    expect(reply.status).toBe(422);
    expect(reply.body.error).toMatchObject({
      kind: 'unknown-operation',
      detail: { kind: 'unknown-operation', type: 'note.transmogrify' },
    });
  });

  it('says which operation of a batch failed', async () => {
    await aChart();
    const reply = await call('POST', '/v1/scores/score-1/ops', {
      operations: [note('bar1.beat2', 'F5'), note('bar1.beat1', 'C5')],
    });
    expect(reply.status).toBe(422);
    expect(reply.body.error).toMatchObject({ operation: 2 });
  });

  it('400s a body that is not JSON at all, which is a different problem from a bad op', async () => {
    const response = await fetch(`${base}/v1/scores`, {
      method: 'POST',
      body: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { kind: string } }).error.kind).toBe('malformed-json');
  });

  it('422s an empty batch', async () => {
    await aChart();
    expect((await call('POST', '/v1/scores/score-1/ops', {})).status).toBe(422);
  });

  it('404s an unknown route and 405s a wrong method, with an Allow header', async () => {
    expect((await call('GET', '/v1/nonsense')).status).toBe(404);
    expect((await call('GET', '/v1/scores/score-1/ops')).status).toBe(405);
    const reply = await call('PUT', '/v1/scores');
    expect(reply.status).toBe(405);
    expect(reply.headers.get('allow')).toBe('GET, POST');
  });

  it('never puts a stack trace or a host path in a response', async () => {
    const replies = [
      await call('GET', '/v1/nonsense'),
      await call('POST', '/v1/scores/nope/ops', { operation: note('bar1.beat1', 'C5') }),
      await call('POST', '/v1/scores', { operation: { type: 'nope' } as unknown as Operation }),
    ];
    for (const reply of replies) {
      const text = JSON.stringify(reply.body);
      expect(text).not.toMatch(/\/home\/|[A-Z]:\\\\|node_modules|at Object\./);
    }
  });
});

describe('a batch is transactional over HTTP too (ADR-0008)', () => {
  it('applies all of a good batch as one version bump', async () => {
    const version = await aChart();
    const reply = await call('POST', '/v1/scores/score-1/ops', {
      operations: [note('bar1.beat2', 'F5'), note('bar1.beat3', 'G5'), note('bar1.beat4', 'Ab5')],
    });
    expect(reply.body.version).toBe(version + 1);
    expect(reply.body.changed).toEqual(['note-2', 'note-3', 'note-4']);
  });

  it('applies none of a batch with one bad operation', async () => {
    await aChart();
    const before = await call('GET', '/v1/scores/score-1');

    await call('POST', '/v1/scores/score-1/ops', {
      operations: [note('bar1.beat2', 'F5'), note('bar1.beat1', 'C5'), note('bar1.beat3', 'G5')],
    });

    const after = await call('GET', '/v1/scores/score-1');
    expect(after.body).toEqual(before.body);
  });

  it('treats a batch of one exactly like a lone operation', async () => {
    // One code path, so the two cannot drift — which is the sort of divergence that only shows up
    // in the case nobody tested.
    await aChart();
    const single = await call('POST', '/v1/scores/score-1/ops', { operation: note('bar1.beat2', 'F5') });
    await call('DELETE', '/v1/scores/score-1');
    await aChart();
    const batched = await call('POST', '/v1/scores/score-1/ops', { operations: [note('bar1.beat2', 'F5')] });
    expect(batched.body).toEqual(single.body);
  });
});

describe('the Origin check (ADR-0029)', () => {
  it('rejects a state-changing request from a foreign origin', async () => {
    // The drive-by path: a page the user happens to be visiting, issuing a write.
    const reply = await call('POST', '/v1/scores', { operation: CREATE }, {
      origin: 'https://evil.example',
    });
    expect(reply.status).toBe(403);
    expect((reply.body.error as { kind: string }).kind).toBe('foreign-origin');
    // And nothing happened.
    expect((await call('GET', '/v1/scores')).body.scores).toEqual([]);
  });

  it('rejects a foreign-origin delete as readily as a post', async () => {
    await aChart();
    const reply = await call('DELETE', '/v1/scores/score-1', undefined, {
      origin: 'https://evil.example',
    });
    expect(reply.status).toBe(403);
    expect((await call('GET', '/v1/scores/score-1')).status).toBe(200);
  });

  it('accepts a state-changing request from its own origin', async () => {
    const reply = await call('POST', '/v1/scores', { operation: CREATE }, { origin: base });
    expect(reply.status).toBe(201);
  });

  it('accepts localhost as well as 127.0.0.1, since the UI dev server may use either', async () => {
    const port = new URL(base).port;
    const reply = await call('POST', '/v1/scores', { operation: CREATE }, {
      origin: `http://localhost:${port}`,
    });
    expect(reply.status).toBe(201);
  });

  it('accepts a request with no Origin at all, because that is the CLI', async () => {
    // Not a hole: a browser always sends Origin on a cross-origin request, including a form POST.
    // Absence means the caller is not a browser page, and the CLI is half the intended users.
    expect((await call('POST', '/v1/scores', { operation: CREATE })).status).toBe(201);
  });

  it('does not gate a plain read on Origin', async () => {
    await aChart();
    const reply = await call('GET', '/v1/scores/score-1', undefined, { origin: 'https://evil.example' });
    // The Host check is what protects a read; Origin governs state-changing requests only.
    expect(reply.status).toBe(200);
  });

  it('never answers with a CORS header, wildcard least of all', async () => {
    for (const reply of [await call('GET', '/v1/health'), await call('GET', '/v1/scores')]) {
      expect(reply.headers.get('access-control-allow-origin')).toBeNull();
      expect(reply.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });
});

describe('the Host check', () => {
  it('rejects a request addressed to a name that is not loopback', async () => {
    // What DNS rebinding looks like from in here. This closes the *read* path too, which an Origin
    // check on state-changing requests alone would leave open.
    const reply = await raw('GET', '/v1/scores', { host: 'evil.example' });
    expect(reply.status).toBe(403);
    expect((reply.body.error as { kind: string }).kind).toBe('foreign-host');
  });

  it('rejects a rebound read of a real score, which is the point of checking it', async () => {
    await aChart();
    const reply = await raw('GET', '/v1/scores/score-1', { host: 'evil.example' });
    expect(reply.status).toBe(403);
    expect(JSON.stringify(reply.body)).not.toContain('Body and Soul');
  });

  it('rejects it before routing, so an unknown path is not a way past the guard', async () => {
    expect((await raw('GET', '/v1/nonsense', { host: 'evil.example' })).status).toBe(403);
  });

  it('never reaches the app without a Host, because Node refuses one first', async () => {
    // Node's own HTTP server answers an HTTP/1.1 request with no Host with a 400, per RFC 7230, so
    // the guard's own no-Host branch is unreachable over the wire. It stays as defence in depth and
    // is covered directly in tests/unit/guards.test.ts.
    expect((await raw('GET', '/v1/health', {})).status).toBe(400);
  });

  it('accepts localhost and 127.0.0.1, with or without a port', async () => {
    const port = new URL(base).port;
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, 'localhost', '[::1]']) {
      expect((await raw('GET', '/v1/health', { host })).status).toBe(200);
    }
  });
});

describe('the hosting-shaped constraint (ADR-0001)', () => {
  it('accepts no filesystem path anywhere in a route', async () => {
    // The routes address scores by id. There is no path parameter, no `?file=`, and nothing that
    // would become a traversal once this is hosted.
    for (const attempt of [
      '/v1/scores/../../etc/passwd',
      '/v1/scores/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/v1/scores/score-1/../../ops',
    ]) {
      const reply = await call('GET', attempt);
      expect([301, 404]).toContain(reply.status);
    }
  });

  it('exposes no filesystem path in any response', async () => {
    await aChart();
    const replies = [
      await call('GET', '/v1/health'),
      await call('GET', '/v1/scores'),
      await call('GET', '/v1/scores/score-1'),
    ];
    for (const reply of replies) {
      expect(JSON.stringify(reply.body)).not.toMatch(/\/home\/|\/tmp\/|[A-Z]:\\\\|\.db\b/);
    }
  });
});

describe('the auth seam', () => {
  it('scopes everything to the principal it resolves', async () => {
    await aChart();

    // A second API over the same store, resolving a different principal. Nothing of the first
    // principal's library is visible — which is the property that makes the hosted transition a
    // change to this function rather than to every query.
    const other = createApi({
      store,
      logger: silentLogger,
      authenticate: () => ({ owner: 'someone-else' }),
    });
    const { port } = await other.listen(0);
    try {
      const reply = await fetch(`http://127.0.0.1:${port}/v1/scores`);
      expect(await reply.json()).toEqual({ scores: [] });
      expect((await fetch(`http://127.0.0.1:${port}/v1/scores/score-1`)).status).toBe(404);
    } finally {
      await other.close();
    }
  });

  it('401s when it resolves nobody', async () => {
    const closed = createApi({ store, logger: silentLogger, authenticate: () => null });
    const { port } = await closed.listen(0);
    try {
      expect((await fetch(`http://127.0.0.1:${port}/v1/health`)).status).toBe(401);
    } finally {
      await closed.close();
    }
  });
});

describe('the body cap', () => {
  it('refuses a body past the cap rather than reading it all', async () => {
    const huge = 'x'.repeat(1_100_000);
    const response = await fetch(`${base}/v1/scores`, {
      method: 'POST',
      body: JSON.stringify({ operation: { type: 'score.create', payload: { id: huge } } }),
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(413);
  });
});
