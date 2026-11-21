import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pkce, startHosted } from './hosted-support.js';
import type { Hosted } from './hosted-support.js';

/**
 * The remote MCP endpoint (V22a, ADR-0034 decision 5), over a real socket and a real hosted API: the door
 * it keeps (bearer only, `mcp:` audience, per-tool scope), the tools, and the claim the whole slice rests
 * on — a tool's result is the API's own structured response or error, and it cannot reach another owner's
 * chart.
 */

let h: Hosted;
beforeEach(async () => {
  h = await startHosted();
});
afterEach(async () => {
  await h.close();
});

let rpcId = 0;
async function rpc(token: string | null, method: string, params?: unknown, extra: Record<string, string> = {}) {
  const reply = await h.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...extra },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params === undefined ? {} : { params }) }),
  });
  return reply;
}

async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const reply = await rpc(token, 'tools/call', { name, arguments: args });
  expect(reply.status).toBe(200);
  return reply.json().result as { content: any[]; structuredContent: any; isError?: boolean };
}

async function userWithToken(login: string, scopes: ('mcp:read' | 'mcp:write')[] = ['mcp:read', 'mcp:write']) {
  const user = await h.signIn(login);
  return { ...user, token: await h.mintToken(user.userId, scopes) };
}

const createOps = (id: string) => [{ type: 'score.create', payload: { id, barCount: 4, title: `Chart ${id}` } }];

describe('the door', () => {
  it('answers a caller with no token by saying where to learn how to get one', async () => {
    const reply = await rpc(null, 'ping');
    expect(reply.status).toBe(401);
    expect(reply.headers['www-authenticate']).toBe('Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"');
    // ...and that URL is real, and public.
    expect((await h.request('/.well-known/oauth-protected-resource')).status).toBe(200);
  });

  it('refuses a session cookie, however good', async () => {
    const { cookie } = await h.signIn('alice');
    const reply = await h.request('/mcp', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(reply.status).toBe(401);
  });

  it('refuses an unknown token, and a /v1/ token as issued for another audience', async () => {
    const unknown = await rpc('sbs_nope', 'ping');
    expect(unknown.status).toBe(401);
    expect(unknown.headers['www-authenticate']).toContain('error="invalid_token"');

    const { userId } = await h.signIn('alice');
    const apiToken = await h.mintToken(userId, ['read', 'write']);
    const wrong = await rpc(apiToken, 'ping');
    expect(wrong.status).toBe(401);
    expect(wrong.json().error.kind).toBe('wrong-audience');
  });

  it('refuses a revoked token at once', async () => {
    const { userId, token } = await userWithToken('alice');
    expect((await rpc(token, 'ping')).status).toBe(200);
    const id = (await h.auth.listTokens(userId))[0]!.id;
    await h.auth.revokeToken(userId, id);
    expect((await rpc(token, 'ping')).status).toBe(401);
  });

  it('is POST only: no stream, no session to delete', async () => {
    const { token } = await userWithToken('alice');
    for (const method of ['GET', 'DELETE']) {
      const reply = await h.request('/mcp', { method, headers: { authorization: `Bearer ${token}` } });
      expect(reply.status).toBe(405);
      expect(reply.headers.allow).toBe('POST');
    }
  });

  it('is not there on a local install', async () => {
    // The local API (no `hosted`) has no OAuth tokens to check, so no /mcp: it is a route miss like any other.
    const { createApi } = await import('@sibei/api');
    const { openSqliteStore } = await import('@sibei/api/sqlite');
    const store = openSqliteStore({ filename: ':memory:' });
    const api = createApi({ store, logger: { request: () => {}, error: () => {} } });
    const { port } = await api.listen(0);
    try {
      const reply = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' });
      expect(reply.status).toBe(404);
    } finally {
      await api.close();
      await store.close();
    }
  });
});

describe('the protocol', () => {
  it('negotiates a protocol version and advertises tools', async () => {
    const { token } = await userWithToken('alice');
    const init = (await rpc(token, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } })).json();
    expect(init.result.protocolVersion).toBe('2025-03-26');
    expect(init.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(init.result.serverInfo.name).toBe('sibei-score');
    const future = (await rpc(token, 'initialize', { protocolVersion: '2099-01-01' })).json();
    expect(future.result.protocolVersion).toBe('2025-06-18');
  });

  it('acknowledges a notification with 202 and no body', async () => {
    const { token } = await userWithToken('alice');
    const reply = await h.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(reply.status).toBe(202);
    expect(reply.body).toBe('');
  });

  it('lists only the tools a token may run', async () => {
    const both = await userWithToken('alice');
    const names = (await rpc(both.token, 'tools/list')).json().result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(['list_scores', 'read_score', 'create_score', 'edit_score', 'undo', 'redo', 'export_score']);
    const reader = await userWithToken('bob', ['mcp:read']);
    const readable = (await rpc(reader.token, 'tools/list')).json().result.tools.map((t: { name: string }) => t.name);
    expect(readable).toEqual(['list_scores', 'read_score', 'export_score']);
  });

  it('gives every tool a JSON schema an agent can use', async () => {
    const { token } = await userWithToken('alice');
    const tools = (await rpc(token, 'tools/list')).json().result.tools;
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
    }
    const edit = tools.find((t: { name: string }) => t.name === 'edit_score');
    expect(edit.inputSchema.required).toEqual(['id', 'expectedVersion', 'operations']);
    expect(edit.inputSchema.properties.operations.items.properties.type.enum).toContain('chord.set');
    expect(edit.inputSchema.properties.operations.items.properties.type.enum).not.toContain('score.import');
  });

  it('answers an unknown method and an unknown tool as JSON-RPC errors', async () => {
    const { token } = await userWithToken('alice');
    expect((await rpc(token, 'resources/list')).json().error.code).toBe(-32601);
    expect((await rpc(token, 'tools/call', { name: 'delete_everything' })).json().error.code).toBe(-32602);
  });
});

describe('the tools', () => {
  it('creates, edits and reads a chart, and every result is the API\'s own', async () => {
    const { token } = await userWithToken('alice');

    const created = await call(token, 'create_score', { operations: createOps('soul') });
    expect(created.isError).toBeUndefined();
    expect(created.structuredContent).toMatchObject({ scoreId: 'soul', version: 1 });
    // The text content is the same JSON, for a client that ignores structuredContent.
    expect(JSON.parse(created.content[0].text)).toEqual(created.structuredContent);

    const edited = await call(token, 'edit_score', {
      id: 'soul',
      expectedVersion: 1,
      operations: [
        { type: 'note.add', target: 'bar1.beat1', payload: { pitch: 'E5', duration: { value: 4, dots: 0 } } },
        { type: 'note.add', target: 'bar2.beat1', payload: { pitch: 'F5', duration: { value: 4, dots: 0 } } },
        { type: 'chord.set', target: 'bar1.beat1', payload: { text: 'Cmaj7' } },
        { type: 'chord.set', target: 'bar2.beat1', payload: { text: 'Dm7' } },
      ],
    });
    expect(edited.isError).toBeUndefined();
    expect(edited.structuredContent.version).toBe(2);

    const read = await call(token, 'read_score', { id: 'soul' });
    expect(read.structuredContent.version).toBe(2);
    expect(read.structuredContent.projection).toContain('Cmaj7');
    expect(read.structuredContent.projection).toContain('Dm7');
    expect(read.content[0].text).toContain('version: 2');

    const full = await call(token, 'read_score', { id: 'soul', format: 'json' });
    expect(full.structuredContent.score.bars).toHaveLength(4);

    const listed = await call(token, 'list_scores');
    expect(listed.structuredContent.scores).toMatchObject([{ id: 'soul', version: 2, title: 'Chart soul' }]);
  });

  it('writes through the applier: the same edit over /v1/ and /mcp lands in one log, and undo undoes a batch', async () => {
    const { token, cookie } = await userWithToken('alice');
    await call(token, 'create_score', { operations: createOps('soul') });
    await call(token, 'edit_score', {
      id: 'soul',
      expectedVersion: 1,
      operations: [{ type: 'chord.set', target: 'bar1.beat1', payload: { text: 'Cmaj7' } }],
    });
    // The browser/CLI door sees the MCP write at the same version.
    const viaApi = (await h.request('/v1/scores/soul', { headers: { cookie } })).json();
    expect(viaApi.version).toBe(2);

    const undone = await call(token, 'undo', { id: 'soul', expectedVersion: 2 });
    expect(undone.structuredContent).toMatchObject({ moved: true });
    const redone = await call(token, 'redo', { id: 'soul', expectedVersion: undone.structuredContent.version });
    expect(redone.structuredContent).toMatchObject({ moved: true });
  });

  it('surfaces currentVersion on a stale write, in the API\'s own error shape', async () => {
    const { token } = await userWithToken('alice');
    await call(token, 'create_score', { operations: createOps('soul') });
    await call(token, 'edit_score', {
      id: 'soul',
      expectedVersion: 1,
      operations: [{ type: 'chord.set', target: 'bar1.beat1', payload: { text: 'C' } }],
    });
    const stale = await call(token, 'edit_score', {
      id: 'soul',
      expectedVersion: 1,
      operations: [{ type: 'chord.set', target: 'bar1.beat1', payload: { text: 'D' } }],
    });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent.error).toMatchObject({ kind: 'stale-version', currentVersion: 2 });
    expect(JSON.parse(stale.content[0].text)).toEqual(stale.structuredContent);
  });

  it('reports which operation failed and why, with the data to correct it', async () => {
    const { token } = await userWithToken('alice');
    await call(token, 'create_score', { operations: createOps('soul') });
    const bad = await call(token, 'edit_score', {
      id: 'soul',
      expectedVersion: 1,
      operations: [
        { type: 'chord.set', target: 'bar1.beat1', payload: { text: 'C' } },
        { type: 'note.set', target: 'bar9.n1', payload: { pitch: 'C5' } },
      ],
    });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.error).toMatchObject({ kind: 'address', operation: 2 });
    expect(bad.structuredContent.error.detail).toBeDefined();
    // All or nothing: the first operation did not land.
    const read = await call(token, 'read_score', { id: 'soul' });
    expect(read.structuredContent.version).toBe(1);
  });

  it('requires an expectedVersion on every write, and reports missing arguments as validation', async () => {
    const { token } = await userWithToken('alice');
    await call(token, 'create_score', { operations: createOps('soul') });
    const noVersion = await call(token, 'edit_score', { id: 'soul', operations: [{ type: 'meta.set', payload: { title: 'x' } }] });
    expect(noVersion.isError).toBe(true);
    expect(noVersion.structuredContent.error.kind).toBe('validation');
    const noOps = await call(token, 'create_score', {});
    expect(noOps.structuredContent.error.kind).toBe('validation');
  });

  it('refuses the server-only score.import, as the /v1/ ops route does', async () => {
    const { token } = await userWithToken('alice');
    await call(token, 'create_score', { operations: createOps('soul') });
    const result = await call(token, 'edit_score', {
      id: 'soul',
      expectedVersion: 1,
      operations: [{ type: 'score.import', payload: { document: {} } }],
    });
    expect(result.isError).toBe(true);
  });

  it('exports a PDF as an embedded resource and MusicXML as text', async () => {
    const { token } = await userWithToken('alice');
    await call(token, 'create_score', { operations: createOps('soul') });

    const pdf = await call(token, 'export_score', { id: 'soul' });
    expect(pdf.structuredContent).toMatchObject({ contentType: 'application/pdf', filename: 'Chart soul.pdf' });
    const resource = pdf.content[1].resource;
    expect(resource.mimeType).toBe('application/pdf');
    expect(Buffer.from(resource.blob, 'base64').subarray(0, 4).toString()).toBe('%PDF');

    const xml = await call(token, 'export_score', { id: 'soul', format: 'musicxml' });
    expect(xml.content[1].resource.text).toContain('<score-partwise');

    const bad = await call(token, 'export_score', { id: 'soul', paper: 'tabloid' });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.error).toMatchObject({ kind: 'unsupported-paper' });
    expect(bad.structuredContent.error.detail.supported).toContain('a4');
  });
});

describe('scope and tenancy', () => {
  it('refuses a write from a token without mcp:write, and a read from none that can read', async () => {
    const owner = await userWithToken('alice');
    await call(owner.token, 'create_score', { operations: createOps('soul') });

    const reader = await h.mintToken(owner.userId, ['mcp:read']);
    expect((await call(reader, 'read_score', { id: 'soul' })).isError).toBeUndefined();
    const refused = await call(reader, 'edit_score', { id: 'soul', expectedVersion: 1, operations: [{ type: 'meta.set', payload: { title: 'x' } }] });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.error.kind).toBe('insufficient-scope');
    expect((await call(reader, 'create_score', { operations: createOps('other') })).structuredContent.error.kind).toBe('insufficient-scope');

    const writer = await h.mintToken(owner.userId, ['mcp:write']);
    expect((await call(writer, 'read_score', { id: 'soul' })).structuredContent.error.kind).toBe('insufficient-scope');
    // And nothing was written by the refused calls.
    expect(((await h.store.get(owner.userId, 'soul'))!).version).toBe(1);
  });

  it('cannot address another owner\'s chart by any tool', async () => {
    const alice = await userWithToken('alice');
    const bob = await userWithToken('bob');
    await call(alice.token, 'create_score', { operations: createOps('private') });

    const read = await call(bob.token, 'read_score', { id: 'private' });
    expect(read.structuredContent.error.kind).toBe('no-such-score');
    const edit = await call(bob.token, 'edit_score', { id: 'private', expectedVersion: 1, operations: [{ type: 'meta.set', payload: { title: 'mine' } }] });
    expect(edit.structuredContent.error.kind).toBe('no-such-score');
    expect((await call(bob.token, 'undo', { id: 'private', expectedVersion: 1 })).isError).toBe(true);
    expect((await call(bob.token, 'export_score', { id: 'private' })).structuredContent.error.kind).toBe('no-such-score');
    expect((await call(bob.token, 'list_scores')).structuredContent.scores).toEqual([]);
    // Alice's chart is untouched, and bob can use the same id for his own.
    expect((await h.store.get(alice.userId, 'private'))!.version).toBe(1);
    expect((await call(bob.token, 'create_score', { operations: createOps('private') })).isError).toBeUndefined();
  });
});

describe('the whole thing, as an MCP client would do it', () => {
  it('discovers, registers, gets consent, exchanges a code, then creates and edits a chart', async () => {
    // Discovery, with no credential at all.
    const unauth = await rpc(null, 'initialize', { protocolVersion: '2025-06-18' });
    expect(unauth.status).toBe(401);
    const resourceMeta = (await h.request(new URL(/resource_metadata="([^"]+)"/.exec(String(unauth.headers['www-authenticate']))![1]!).pathname)).json();
    const serverMeta = (await h.request('/.well-known/oauth-authorization-server')).json();
    expect(resourceMeta.authorization_servers).toEqual([serverMeta.issuer]);

    // Registration.
    const redirect = 'http://127.0.0.1:7777/callback';
    const registered = (
      await h.request(new URL(serverMeta.registration_endpoint).pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirect], client_name: 'Claude' }),
      })
    ).json();

    // Authorise, and the person (already signed in) consents.
    const { verifier, challenge } = pkce();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: registered.client_id,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's1',
      resource: resourceMeta.resource,
    });
    const authorize = await h.request(`${new URL(serverMeta.authorization_endpoint).pathname}?${query}`);
    expect(authorize.status).toBe(302);
    const consent = Object.fromEntries(new URLSearchParams(new URL(authorize.headers.location!, 'http://x').hash.slice('#/authorize?'.length)));
    const { cookie } = await h.signIn('alice');
    const approved = (
      await h.request('/v1/auth/oauth/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ ...consent, approve: true }),
      })
    ).json();
    const code = new URL(approved.redirectTo).searchParams.get('code')!;

    // Exchange.
    const tokenReply = await h.request(new URL(serverMeta.token_endpoint).pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: registered.client_id, code_verifier: verifier, resource: resourceMeta.resource }).toString(),
    });
    const token = tokenReply.json().access_token as string;

    // Use.
    expect((await rpc(token, 'initialize', { protocolVersion: '2025-06-18' })).status).toBe(200);
    await call(token, 'create_score', { operations: createOps('standard') });
    const edited = await call(token, 'edit_score', {
      id: 'standard',
      expectedVersion: 1,
      operations: [{ type: 'chord.set', target: 'bar1.beat1', payload: { text: 'Dm7' } }],
    });
    expect(edited.structuredContent.version).toBe(2);
    expect((await call(token, 'read_score', { id: 'standard' })).structuredContent.projection).toContain('Dm7');
  });
});
