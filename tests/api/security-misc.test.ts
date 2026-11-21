import { afterEach, describe, expect, it } from 'vitest';
import { startHosted } from './hosted-support.js';
import type { Hosted } from './hosted-support.js';

/** The pre-launch review's low findings that live in the API: Origin null, duplicate cookies, bad escapes. */

let h: Hosted | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('the boundary', () => {
  it('refuses a state-changing request from an opaque origin that carries a session, and admits one without', async () => {
    h = await startHosted();
    const { cookie } = await h.signIn('mallory');
    const post = (headers: Record<string, string>) =>
      h!.request('/v1/scores', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'null', ...headers }, body: '{}' });
    expect((await post({ cookie })).status).toBe(403);
    // no cookie: nothing ambient to abuse; it reaches authentication (401), not the origin guard
    expect((await post({})).status).toBe(401);
  });

  it('does not trust the first of two session cookies with the same name', async () => {
    h = await startHosted();
    const { cookie } = await h.signIn('mallory');
    expect((await h.request('/v1/me', { headers: { cookie } })).status).toBe(200);
    expect((await h.request('/v1/me', { headers: { cookie: `${cookie}; ${cookie.replace(/=.*/, '=planted')}` } })).status).toBe(401);
  });

  it('answers a malformed percent escape with 400, not 500', async () => {
    h = await startHosted();
    const { cookie } = await h.signIn('mallory');
    const reply = await h.request('/v1/scores/%E0%A4%A', { headers: { cookie } });
    expect(reply.status).toBe(400);
    expect(reply.json().error.kind).toBe('malformed-path');
  });
});
