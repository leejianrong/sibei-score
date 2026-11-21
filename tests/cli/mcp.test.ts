import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, run } from '@sibei/cli';
import { startHosted } from '../api/hosted-support.js';
import type { Hosted } from '../api/hosted-support.js';

/**
 * `sbscore mcp` (V22b): the stdio transport over the same tools `/mcp` serves, against a real hosted server.
 *
 * The claim is **parity**: one scripted conversation is run twice — as an MCP client would over HTTP at `/mcp`
 * (one user, an `mcp:` token), and over stdio through `sbscore mcp` (another user, a CLI `read`/`write`
 * token) — and the tool results must be the same. They are different credentials on different users, so the
 * two cannot interfere, and nothing but the transport and the token's audience differs.
 */

let h: Hosted;
const savedToken = process.env.SBSCORE_TOKEN;

beforeEach(async () => {
  // A pinned score-store clock: `updatedAt` is second-granular and is also embedded in the tool results' text,
  // so two runs straddling a tick would differ. Pinning it keeps the full-equality assertion honest.
  h = await startHosted({ now: () => new Date('2026-01-01T00:00:00Z') });
});
afterEach(async () => {
  await h.close();
  if (savedToken === undefined) delete process.env.SBSCORE_TOKEN;
  else process.env.SBSCORE_TOKEN = savedToken;
});

/** The conversation: initialise, list tools, create, edit, a stale edit, an address miss, read, export. */
const createOps = [{ type: 'score.create', payload: { id: 'soul', barCount: 4, title: 'Soul' } }];
const note = { type: 'note.add', target: 'bar1.beat1', payload: { pitch: 'E5', duration: { value: 4, dots: 0 } } };
const chord = { type: 'chord.set', target: 'bar1.beat1', payload: { text: 'Cmaj7' } };
const script: { method: string; params?: unknown }[] = [
  { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
  { method: 'tools/list' },
  { method: 'tools/call', params: { name: 'create_score', arguments: { operations: createOps } } },
  { method: 'tools/call', params: { name: 'edit_score', arguments: { id: 'soul', expectedVersion: 1, operations: [note, chord] } } },
  { method: 'tools/call', params: { name: 'edit_score', arguments: { id: 'soul', expectedVersion: 1, operations: [chord] } } },
  { method: 'tools/call', params: { name: 'edit_score', arguments: { id: 'soul', expectedVersion: 2, operations: [{ type: 'note.set', target: 'bar9.n1', payload: { pitch: 'C5' } }] } } },
  { method: 'tools/call', params: { name: 'read_score', arguments: { id: 'soul' } } },
  { method: 'tools/call', params: { name: 'read_score', arguments: { id: 'nope' } } },
  { method: 'tools/call', params: { name: 'undo', arguments: { id: 'soul', expectedVersion: 2 } } },
  { method: 'tools/call', params: { name: 'export_score', arguments: { id: 'soul', format: 'musicxml' } } },
  { method: 'tools/call', params: { name: 'export_score', arguments: { id: 'soul', paper: 'tabloid' } } },
  { method: 'tools/call', params: { name: 'list_scores' } },
];


async function overHttp(token: string): Promise<unknown[]> {
  const results: unknown[] = [];
  let id = 0;
  for (const step of script) {
    const reply = await h.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: step.method, ...(step.params === undefined ? {} : { params: step.params }) }),
    });
    results.push(reply.json().result);
  }
  return results;
}

async function overStdio(token: string, lines: string[] = script.map((s, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: s.method, ...(s.params === undefined ? {} : { params: s.params }) }))) {
  process.env.SBSCORE_TOKEN = token;
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(['mcp', '--url', h.base], {
    io: { out: (t) => out.push(t), err: (t) => err.push(t) },
    mcpInput: Readable.from(lines.map((l) => `${l}\n`)),
    credentialsPath: '/nonexistent/credentials.json',
  });
  return { code, out, err };
}

describe('sbscore mcp', () => {
  it('gives the same tool results as /mcp, byte for byte', async () => {
    const viaMcp = await h.signIn('alice');
    const mcpToken = await h.mintToken(viaMcp.userId, ['mcp:read', 'mcp:write']);
    const viaCli = await h.signIn('bob');
    const cliToken = await h.mintToken(viaCli.userId, ['read', 'write']);

    const http = await overHttp(mcpToken);
    const stdio = await overStdio(cliToken);

    expect(stdio.code).toBe(EXIT.ok);
    expect(stdio.err).toEqual([]);
    const lines = stdio.out.map((line) => JSON.parse(line) as { id: number; result: unknown });
    expect(lines.map((l) => l.id)).toEqual(script.map((_, i) => i + 1));
    expect(lines.map((l) => l.result)).toEqual(http);

    // Spot-check that the comparison is not comparing two empty things.
    const results = lines.map((l) => l.result) as any[];
    expect(results[2].structuredContent).toMatchObject({ scoreId: 'soul', version: 1 });
    expect(results[4].structuredContent.error).toMatchObject({ kind: 'stale-version', currentVersion: 2 });
    expect(results[5].structuredContent.error).toMatchObject({ kind: 'address' });
    expect(results[7].structuredContent.error.kind).toBe('no-such-score');
    expect(results[10].structuredContent.error.kind).toBe('unsupported-paper');
  });

  it('is an HTTP client of the API, so its writes land through the applier and show in the library', async () => {
    const user = await h.signIn('alice');
    const token = await h.mintToken(user.userId, ['read', 'write']);
    await overStdio(token);
    // The same chart, now read through the API's own door.
    const viaApi = (await h.request('/v1/scores/soul', { headers: { authorization: `Bearer ${token}` } })).json();
    expect(viaApi.score.meta.title).toBe('Soul');
    expect(viaApi.version).toBeGreaterThanOrEqual(2);
  });

  it('reports a read-only credential\'s refusal as the API\'s own error, in the tool result', async () => {
    const user = await h.signIn('alice');
    const token = await h.mintToken(user.userId, ['read']);
    const { out } = await overStdio(token, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_score', arguments: { operations: createOps } } }),
    ]);
    const result = JSON.parse(out[0]!).result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.kind).toBe('insufficient-scope');
  });

  it('answers a line that is not JSON with the parse error and carries on', async () => {
    const user = await h.signIn('alice');
    const token = await h.mintToken(user.userId, ['read', 'write']);
    const { out, code } = await overStdio(token, ['not json', '', JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })]);
    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(out[0]!)).toMatchObject({ id: null, error: { code: -32700 } });
    expect(JSON.parse(out[1]!)).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
  });

  it('writes nothing but protocol to stdout, and sends no reply to a notification', async () => {
    const user = await h.signIn('alice');
    const token = await h.mintToken(user.userId, ['read', 'write']);
    const { out } = await overStdio(token, [
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    ]);
    expect(out).toHaveLength(1);
    for (const line of out) expect(JSON.parse(line).jsonrpc).toBe('2.0');
  });

  it('works against a local server too, which needs no credential', async () => {
    const { createApi } = await import('@sibei/api');
    const { openSqliteStore } = await import('@sibei/api/sqlite');
    const store = openSqliteStore({ filename: ':memory:' });
    const api = createApi({ store, logger: { request: () => {}, error: () => {} } });
    const { port } = await api.listen(0);
    try {
      delete process.env.SBSCORE_TOKEN;
      const out: string[] = [];
      await run(['mcp', '--url', `http://127.0.0.1:${port}`], {
        io: { out: (t) => out.push(t), err: () => {} },
        mcpInput: Readable.from([
          `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_score', arguments: { operations: createOps } } })}\n`,
        ]),
        credentialsPath: '/nonexistent/credentials.json',
      });
      expect(JSON.parse(out[0]!).result.structuredContent).toMatchObject({ scoreId: 'soul', version: 1 });
    } finally {
      await api.close();
      await store.close();
    }
  });
});
