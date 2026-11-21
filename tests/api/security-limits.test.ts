import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, addressBucket, createLimits } from '@sibei/api';
import { startHosted } from './hosted-support.js';
import type { Hosted } from './hosted-support.js';

/** The pre-launch security review's rate-limit findings (SEC H2, M5). */

let h: Hosted | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function rpc(token: string, body: unknown) {
  return h!.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
const ping = (id: number) => ({ jsonrpc: '2.0', id, method: 'ping' });
const exportCall = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'export_score', arguments: { id: 'nope' } } });

async function mcpUser(config = DEFAULT_LIMITS) {
  h = await startHosted({ limits: createLimits({ config }) });
  const user = await h.signIn('mallory');
  return h.mintToken(user.userId, ['mcp:read', 'mcp:write']);
}

describe('/mcp', () => {
  it('refuses a JSON-RPC batch longer than the cap without running any of it', async () => {
    const token = await mcpUser();
    const reply = await rpc(token, Array.from({ length: 11 }, (_, n) => ping(n)));
    expect(reply.status).toBe(200);
    expect(reply.json().error.message).toMatch(/capped at 10/);
    expect((await rpc(token, Array.from({ length: 10 }, (_, n) => ping(n)))).json()).toHaveLength(10);
  });

  it('charges each tool call to the per-user class its REST route would use', async () => {
    const token = await mcpUser({ ...DEFAULT_LIMITS, rates: { ...DEFAULT_LIMITS.rates, export: { limit: 2, windowMs: 60_000 } } });
    expect((await rpc(token, [exportCall(1), exportCall(2)])).status).toBe(200);
    const refused = await rpc(token, exportCall(3));
    expect(refused.status).toBe(429);
    expect(refused.json().error.detail.class).toBe('export');
    // a read is its own budget, unaffected
    expect((await rpc(token, ping(4))).status).toBe(200);
  });
});

describe('per-IP keys', () => {
  it('limits an IPv6 address by its /64, and an IPv4-mapped one as IPv4', () => {
    expect(addressBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(addressBucket('2001:db8:1:2:1::9'));
    expect(addressBucket('2001:db8:1:2::1')).not.toBe(addressBucket('2001:db8:1:3::1'));
    expect(addressBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(addressBucket('203.0.113.7')).toBe('203.0.113.7');
  });
});

describe('the limiter failing', () => {
  const broken = { consume: () => Promise.reject(new Error('redis is down')) };
  const fakeRequest = (method: string, url: string) => ({ method, url, headers: {}, socket: { remoteAddress: '203.0.113.7' } }) as never;

  it('fails open for a read and closed for a write', async () => {
    const limits = createLimits({ limiter: broken, onError: () => {} });
    expect(await limits.gateAddress(fakeRequest('GET', '/v1/scores'))).toBeNull();
    expect(await limits.gateAddress(fakeRequest('POST', '/v1/scores'))).toMatchObject({ scope: 'ip' });
    expect(await limits.gateUser(fakeRequest('GET', '/v1/scores'), 'u')).toBeNull();
    expect(await limits.gateUser(fakeRequest('POST', '/v1/scores'), 'u')).toMatchObject({ scope: 'user', class: 'write' });
  });

  it('counts failed worker authentications per address', async () => {
    const limits = createLimits({ config: { ...DEFAULT_LIMITS, workerFailIp: { limit: 2, windowMs: 60_000 } } });
    const req = fakeRequest('POST', '/v1/worker/claim');
    expect(await limits.workerAuthFailed(req)).toBeNull();
    expect(await limits.workerAuthFailed(req)).toBeNull();
    expect(await limits.workerAuthFailed(req)).toMatchObject({ class: 'worker-auth' });
  });
});
