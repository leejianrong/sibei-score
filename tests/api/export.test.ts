import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, memoryBlobStore, openSqliteStore, silentLogger } from '@sibei/api';
import type { Api, BlobKey, BlobStore, Operation, ScoreStore } from '@sibei/api';
import { dur } from '@sibei/model';

/**
 * `GET /v1/scores/:id/export` over real HTTP against a real store (V3, ADR-0006, Q81).
 *
 * A real socket, like the rest of the API's tests: calling the handler directly would skip the
 * guards ADR-0029 is about, and the export route is a *read* of the whole library, which is
 * precisely what the Host check exists to protect.
 */

/** A blob store that counts, so a cache hit can be asserted rather than inferred from the bytes. */
interface CountingBlobStore extends BlobStore {
  puts: BlobKey[];
  gets: BlobKey[];
}

function countingBlobStore(): CountingBlobStore {
  const inner = memoryBlobStore();
  const counter: CountingBlobStore = {
    puts: [],
    gets: [],
    get(key) {
      counter.gets.push(key);
      return inner.get(key);
    },
    put(key, bytes) {
      counter.puts.push(key);
      return inner.put(key, bytes);
    },
  };
  return counter;
}

let store: ScoreStore;
let blobs: CountingBlobStore;
let api: Api;
let base: string;

beforeEach(async () => {
  store = openSqliteStore({ filename: ':memory:' });
  blobs = countingBlobStore();
  api = createApi({ store, blobs, logger: silentLogger });
  const { port } = await api.listen(0);
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await api.close();
  store.close();
});

const CREATE: Operation = {
  type: 'score.create',
  payload: { id: 'score-1', barCount: 4, title: 'Body and Soul', composer: 'Johnny Green' },
};

const note = (target: string, pitch: string): Operation => ({
  type: 'note.add',
  target,
  payload: { pitch, duration: dur(4) },
});

async function json(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  const text = await response.text();
  return { status: response.status, ...(text === '' ? {} : (JSON.parse(text) as object)) };
}

async function aChart(): Promise<void> {
  await json('POST', '/v1/scores', { operation: CREATE });
  await json('POST', '/v1/scores/score-1/ops', { operation: note('bar1.beat1', 'Eb5') });
}

interface Download {
  status: number;
  bytes: Buffer;
  headers: Headers;
}

async function download(path: string): Promise<Download> {
  const response = await fetch(`${base}${path}`);
  return {
    status: response.status,
    bytes: Buffer.from(await response.arrayBuffer()),
    headers: response.headers,
  };
}

describe('exporting a chart as a PDF (V3, R0)', () => {
  it('renders the stored score and answers with the bytes', async () => {
    await aChart();
    const reply = await download('/v1/scores/score-1/export?format=pdf');

    expect(reply.status).toBe(200);
    expect(reply.headers.get('content-type')).toBe('application/pdf');
    expect(reply.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(Number(reply.headers.get('content-length'))).toBe(reply.bytes.length);
    expect(reply.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('defaults the format, because pdf is the only one there is', async () => {
    await aChart();
    expect((await download('/v1/scores/score-1/export')).status).toBe(200);
  });

  it('names the download after the chart, with the title sanitised for the header', async () => {
    // The stem is user text going into a header. A title holding a quote or a newline would
    // otherwise be a way to write a header of one's own.
    await json('POST', '/v1/scores', {
      operation: { type: 'score.create', payload: { id: 'nasty', barCount: 2, title: 'a"b\r\nx: y' } },
    });
    const reply = await download('/v1/scores/nasty/export');
    expect(reply.headers.get('content-disposition')).toBe('attachment; filename="a b x y.pdf"');
  });

  it('404s a score that is not there, in the shape every other route uses', async () => {
    const response = await fetch(`${base}/v1/scores/nope/export`);
    expect(response.status).toBe(404);
    expect((await response.json() as { error: { kind: string } }).error.kind).toBe('no-such-score');
  });

  it('405s anything but a GET, since an export is a read', async () => {
    await aChart();
    const response = await fetch(`${base}/v1/scores/score-1/export`, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });
});

describe('the cache, keyed by (score version, format, instrument) — Q81', () => {
  it('exports an unchanged score twice to identical bytes, the second from the cache', async () => {
    await aChart();
    const first = await download('/v1/scores/score-1/export?format=pdf');
    const second = await download('/v1/scores/score-1/export?format=pdf');

    expect(second.bytes.equals(first.bytes)).toBe(true);
    // Identical bytes alone would prove only that the render is deterministic, which it is
    // anyway (Q39). One put across two exports is what proves the second one never rendered.
    expect(blobs.puts).toHaveLength(1);
    expect(blobs.gets).toHaveLength(2);
    expect(blobs.puts[0]).toMatch(/^export:score-1:v2:[0-9a-f]{16}:concert:pdf$/);
  });

  it('produces a different artefact after an edit, with no invalidation call anywhere', async () => {
    await aChart();
    const before = await download('/v1/scores/score-1/export');

    await json('POST', '/v1/scores/score-1/ops', { operation: note('bar1.beat3', 'G5') });

    const after = await download('/v1/scores/score-1/export');
    expect(after.bytes.equals(before.bytes)).toBe(false);
    // Nothing was told to invalidate. The version moved, so the key moved, so the second export
    // missed and rendered — which is the whole of Q81's mechanism.
    expect(blobs.puts).toHaveLength(2);
    expect(blobs.puts[0]).toMatch(/^export:score-1:v2:/);
    expect(blobs.puts[1]).toMatch(/^export:score-1:v3:/);
  });

  it('goes back to the old artefact when the score goes back to the old version', async () => {
    // The other half of "no invalidation logic": a key is not consumed by being superseded.
    await aChart();
    const first = await download('/v1/scores/score-1/export');
    await json('POST', '/v1/scores/score-1/ops', { operation: note('bar1.beat3', 'G5') });
    await download('/v1/scores/score-1/export');

    await json('DELETE', '/v1/scores/score-1');
    await aChart();
    const again = await download('/v1/scores/score-1/export');

    expect(again.bytes.equals(first.bytes)).toBe(true);
    expect(blobs.puts).toHaveLength(2);
  });

  it('never serves a deleted chart’s artefact to a new one that reuses its id', async () => {
    // The hole in "(score version, format, instrument)" taken literally: deleting a score
    // destroys its log, so a new score with the same id starts again at version 1. Id and
    // version together are therefore not unique over time, and without something else in the key
    // the second chart is served the first one's PDF.
    await aChart();
    const first = await download('/v1/scores/score-1/export');

    await json('DELETE', '/v1/scores/score-1');
    await json('POST', '/v1/scores', { operation: CREATE });
    await json('POST', '/v1/scores/score-1/ops', { operation: note('bar1.beat1', 'C4') });

    const second = await download('/v1/scores/score-1/export');
    expect(second.bytes.equals(first.bytes)).toBe(false);
  });

  it('does not bump the score’s version, because generating an artefact is not an edit', async () => {
    await aChart();
    const before = await json('GET', '/v1/scores/score-1');
    await download('/v1/scores/score-1/export');
    await download('/v1/scores/score-1/export');
    const after = await json('GET', '/v1/scores/score-1');

    // The same distinction ADR-0028's migration write-back turns on: a read that produced
    // something must not look to a client like somebody else's write (ADR-0003).
    expect(after.version).toBe(before.version);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.score).toEqual(before.score);
  });

  it('keeps the log to the operations that were applied, and no export among them', async () => {
    await aChart();
    await download('/v1/scores/score-1/export');
    const operations = store.operations('local', 'score-1');
    expect(operations.map((entry) => entry.operation.type)).toEqual(['score.create', 'note.add']);
  });
});

describe('a format or an instrument this build cannot produce (ADR-0008)', () => {
  it('422s an unknown format and lists what there is', async () => {
    await aChart();
    const response = await fetch(`${base}/v1/scores/score-1/export?format=midi`);
    expect(response.status).toBe(422);
    expect((await response.json() as { error: unknown }).error).toMatchObject({
      kind: 'unsupported-format',
      detail: { kind: 'unsupported-format', requested: 'midi', supported: ['pdf'] },
    });
  });

  it('422s an unknown instrument, and accepts the one part V3 can render', async () => {
    // ADR-0016 makes a part a render-time view over transposition, and transposition is V6. The
    // parameter is real now because Q81 puts it in the key.
    await aChart();
    const bad = await fetch(`${base}/v1/scores/score-1/export?instrument=bb-trumpet`);
    expect(bad.status).toBe(422);
    expect((await bad.json() as { error: { kind: string } }).error.kind).toBe('unsupported-instrument');

    expect((await download('/v1/scores/score-1/export?instrument=concert')).status).toBe(200);
  });

  it('refuses before it reads, so an unknown format on a missing score is still 422', async () => {
    expect((await fetch(`${base}/v1/scores/nope/export?format=midi`)).status).toBe(422);
  });
});

describe('the boundary guards apply to an export too (ADR-0029)', () => {
  it('refuses a rebound read of a chart, which is what the Host check is for', async () => {
    await aChart();
    const reply = await raw('GET', '/v1/scores/score-1/export');
    expect(reply.status).toBe(403);
    expect(reply.body).not.toContain('%PDF');
  });

  it('scopes an export to the principal, like every other read', async () => {
    await aChart();
    const other = createApi({
      store,
      blobs,
      logger: silentLogger,
      authenticate: () => ({ owner: 'someone-else' }),
    });
    const { port } = await other.listen(0);
    try {
      expect((await fetch(`http://127.0.0.1:${port}/v1/scores/score-1/export`)).status).toBe(404);
    } finally {
      await other.close();
    }
  });

  it('exposes no filesystem path, even though the blob store is one', async () => {
    await aChart();
    const reply = await download('/v1/scores/score-1/export');
    for (const [name, value] of reply.headers) {
      expect(`${name}: ${value}`).not.toMatch(/\/home\/|\/tmp\/|[A-Z]:\\\\|\.db\b/);
    }
  });
});

/** A raw request, for the one header `fetch` refuses to let a test set. */
function raw(method: string, path: string): Promise<{ status: number; body: string }> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port: Number(port), path, method, headers: { host: 'evil.example' }, setHost: false },
      (response) => {
        let text = '';
        response.on('data', (chunk) => (text += String(chunk)));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}
