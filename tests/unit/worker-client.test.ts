import { describe, expect, it } from 'vitest';
import { WorkerError, createHttpWorkerClient } from '@sibei/api';
import { OMR_SCHEMA_VERSION } from '@sibei/model';
import type { OmrDocument } from '@sibei/model';

/**
 * The HTTP worker client (V10): the adapter behind the `WorkerClient` port (ADR-0005). It POSTs an
 * image and reads back an {@link OmrDocument}, and it is where the language-boundary schema guard
 * lives — off-schema worker output must fail here, not downstream. Driven with an injected `fetch`,
 * so no real oemer and no socket.
 */

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

describe('createHttpWorkerClient', () => {
  it('POSTs the image to /recognize with the content type and returns the parsed document', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchStub: typeof fetch = (input, init) => {
      seen = { url: String(input), init: init ?? {} };
      return Promise.resolve(
        new Response(JSON.stringify(aDocument()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };

    const client = createHttpWorkerClient({ url: 'http://worker:8000/', fetch: fetchStub });
    const doc = await client.recognize(Buffer.from([1, 2, 3]), { imagePath: 'page-1', format: 'png' });

    expect(doc.source.imagePath).toBe('page-1');
    expect(seen?.url).toBe('http://worker:8000/recognize?name=page-1');
    expect(seen?.init.method).toBe('POST');
    expect((seen?.init.headers as Record<string, string>)['content-type']).toBe('image/png');
    expect(seen?.init.body).toBeDefined();
  });

  it('sends image/jpeg for a JPEG', async () => {
    let contentType: string | undefined;
    const fetchStub: typeof fetch = (_input, init) => {
      contentType = (init?.headers as Record<string, string>)['content-type'];
      return Promise.resolve(new Response(JSON.stringify(aDocument()), { status: 200 }));
    };
    const client = createHttpWorkerClient({ url: 'http://worker:8000', fetch: fetchStub });
    await client.recognize(Buffer.from([1]), { imagePath: 'p', format: 'jpeg' });
    expect(contentType).toBe('image/jpeg');
  });

  it('raises a WorkerError when the worker is unreachable (Q80)', async () => {
    const fetchStub: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    const client = createHttpWorkerClient({ url: 'http://worker:8000', fetch: fetchStub });
    await expect(
      client.recognize(Buffer.from([1]), { imagePath: 'p', format: 'png' }),
    ).rejects.toThrow(WorkerError);
    await expect(
      client.recognize(Buffer.from([1]), { imagePath: 'p', format: 'png' }),
    ).rejects.toThrow(/could not reach the OMR worker/);
  });

  it('raises a WorkerError on a non-2xx response, carrying the status', async () => {
    const fetchStub: typeof fetch = () =>
      Promise.resolve(new Response('boom', { status: 500 }));
    const client = createHttpWorkerClient({ url: 'http://worker:8000', fetch: fetchStub });
    await expect(
      client.recognize(Buffer.from([1]), { imagePath: 'p', format: 'png' }),
    ).rejects.toThrow(/500/);
  });

  it('raises a WorkerError on a body that is not JSON', async () => {
    const fetchStub: typeof fetch = () =>
      Promise.resolve(new Response('not json at all', { status: 200 }));
    const client = createHttpWorkerClient({ url: 'http://worker:8000', fetch: fetchStub });
    await expect(
      client.recognize(Buffer.from([1]), { imagePath: 'p', format: 'png' }),
    ).rejects.toThrow(/not JSON/);
  });

  it('raises a WorkerError on an off-schema document — the language-boundary guard (ADR-0005)', async () => {
    const fetchStub: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ schemaVersion: 1, source: 'wrong' }), { status: 200 }),
      );
    const client = createHttpWorkerClient({ url: 'http://worker:8000', fetch: fetchStub });
    await expect(
      client.recognize(Buffer.from([1]), { imagePath: 'p', format: 'png' }),
    ).rejects.toThrow(/off-schema/);
  });
});
