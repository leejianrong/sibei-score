import { ApiError, submitOps } from '@sibei/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `submitOps` — the browser's only write path (V4c, ADR-0002, ADR-0003).
 *
 * Mirrors `ui-api-failures.test.ts`'s pattern: a stubbed `fetch` standing in for the API, so the
 * client's own logic is what is under test, not a real server.
 */

function answer(status: number, body: string, contentType = 'application/json'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      lastRequest = init;
      return new Response(body, { status, headers: { 'content-type': contentType } });
    }),
  );
}

let lastRequest: RequestInit | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  lastRequest = undefined;
});

describe('submitOps', () => {
  it('posts the batch as JSON, with the expected version alongside the operations', async () => {
    answer(200, JSON.stringify({ scoreId: 'score-1', version: 6, changed: ['note-1'], applied: [] }));
    await submitOps('score-1', {
      operations: [{ type: 'note.set', target: 'note-1', payload: { pitch: 'Eb4' } }],
      expectedVersion: 5,
    });

    expect(lastRequest?.method).toBe('POST');
    const body = JSON.parse(lastRequest?.body as string);
    expect(body).toEqual({
      operations: [{ type: 'note.set', target: 'note-1', payload: { pitch: 'Eb4' } }],
      expectedVersion: 5,
    });
  });

  it('surfaces a 409 as an ApiError carrying currentVersion, promoted out of the envelope', async () => {
    answer(
      409,
      JSON.stringify({
        error: {
          kind: 'stale-version',
          message: 'expected version 5, score is at version 7',
          detail: { kind: 'stale-version', expected: 5, current: 7 },
          currentVersion: 7,
        },
      }),
    );

    const failure = await submitOps('score-1', {
      operations: [{ type: 'note.set', target: 'note-1', payload: { pitch: 'Eb4' } }],
      expectedVersion: 5,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    const apiError = failure as ApiError;
    expect(apiError.status).toBe(409);
    expect(apiError.kind).toBe('stale-version');
    expect(apiError.currentVersion).toBe(7);
  });

  it('leaves currentVersion undefined for a validation failure, which carries none', async () => {
    answer(
      422,
      JSON.stringify({
        error: { kind: 'address', message: 'bar 12 has no note at beat 3', detail: { onsets: [1, 2.5, 4] } },
      }),
    );

    const failure = await submitOps('score-1', {
      operations: [{ type: 'rest.rm', target: 'bar12.beat3' }],
      expectedVersion: 5,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).currentVersion).toBeUndefined();
  });
});
