import { ApiError, listScores, OfflineError } from '@sibei/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * How the browser tells "the API said no" from "nothing answered".
 *
 * Found by looking, not by a test — the offline screenshot for V4b said *"The server refused
 * that"* over the wrong explanation, with the server stopped. **Stopping the server does not
 * produce a network error in the browser:** the page reaches `/v1` through the dev server's
 * proxy, and a proxy with nothing to proxy to answers `500` with an empty body. Classified as an
 * API answer, that is the same class of failure as the export route silently substituting A4 for
 * a paper it does not recognise — the reader is told the wrong thing and never finds out.
 *
 * The rule is structural rather than a list of statuses, which is what makes it hold for the next
 * proxy as well: every error the API emits carries `{error: {kind, message, detail}}` (ADR-0008),
 * so a 5xx **without** that envelope did not come from the API.
 */

function answer(status: number, body: string, contentType = 'application/json'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status, headers: { 'content-type': contentType } })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the UI client, on a failure', () => {
  it('reads the library when the API answers', async () => {
    answer(200, JSON.stringify({ scores: [{ id: 'score-1' }] }));
    await expect(listScores()).resolves.toHaveLength(1);
  });

  it('calls a bodiless 500 unreachable, because the API never answers without an envelope', async () => {
    // Exactly what Vite's proxy returns with nothing listening behind it.
    answer(500, '', 'text/plain');
    await expect(listScores()).rejects.toBeInstanceOf(OfflineError);
  });

  it('calls a 502 from a gateway unreachable too', async () => {
    answer(502, 'Bad Gateway', 'text/plain');
    await expect(listScores()).rejects.toBeInstanceOf(OfflineError);
  });

  it('keeps a 5xx that does carry an envelope as an API answer', async () => {
    // The API can answer 500 itself, and when it does it says so in ADR-0008's shape. That is a
    // refusal to report, not a server to go and start.
    answer(500, JSON.stringify({ error: { kind: 'internal', message: 'the store threw' } }));
    const failure = await listScores().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).kind).toBe('internal');
    expect((failure as ApiError).message).toBe('the store threw');
  });

  it('carries the structured detail through, so a later card branches on data (ADR-0008)', async () => {
    answer(
      422,
      JSON.stringify({
        error: { kind: 'bad-address', message: 'bar 12 has no note at beat 3', detail: { onsets: [1, 2.5, 4] } },
      }),
    );
    const failure = (await listScores().catch((error: unknown) => error)) as ApiError;
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.status).toBe(422);
    expect(failure.detail).toEqual({ onsets: [1, 2.5, 4] });
  });

  it('leaves a 404 an API answer even without an envelope', async () => {
    // A 4xx is a decision. Only a 5xx can mean "nothing that knows about /v1/ was there".
    answer(404, 'not found', 'text/plain');
    const failure = await listScores().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).not.toBeInstanceOf(OfflineError);
  });

  it('calls a thrown fetch unreachable, which is what a direct connection refusal looks like', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(listScores()).rejects.toBeInstanceOf(OfflineError);
  });
});
