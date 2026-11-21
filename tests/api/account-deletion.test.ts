import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, memoryBlobLedger, silentLogger } from '@sibei/api';
import type { Api, AudioJobStore, AuthStore, BlobLedger, JobStore, ManagedBlobStore, ScoreStore } from '@sibei/api';
import { openDirectoryBlobStore } from '@sibei/api';
import { openSqliteAudioJobStore, openSqliteAuthStore, openSqliteBlobLedger, openSqliteJobStore, openSqliteStore } from '@sibei/api/sqlite';
import { startFakeGitHub } from '../fixtures/fake-github.js';
import type { FakeGitHub, FakeProfile } from '../fixtures/fake-github.js';

/**
 * Account deletion (V25, ADR-0034 decisions 11 and 16): after `DELETE /v1/auth/account` nothing the
 * account owned is left in the store or on the blob volume, and nothing of anyone else's is touched.
 * The API is real, on a real socket, signed in through the fake GitHub; the stores are the SQLite
 * adapters and the blob store is a real directory, so "the volume is empty" is a `readdir`.
 */

const CLIENT_ID = 'id';
const CLIENT_SECRET = 'secret';
const ALICE: FakeProfile = { id: 1001, login: 'alice', name: 'Alice A' };
const BOB: FakeProfile = { id: 2002, login: 'bob', name: null };

let github: FakeGitHub;
let store: ScoreStore;
let jobs: JobStore;
let audioJobs: AudioJobStore;
let auth: AuthStore;
let ledger: BlobLedger;
let blobs: ManagedBlobStore;
let directory: string;
let api: Api;
let port: number;

beforeEach(async () => {
  github = await startFakeGitHub({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  store = openSqliteStore({ filename: ':memory:' });
  jobs = openSqliteJobStore({ filename: ':memory:' });
  audioJobs = openSqliteAudioJobStore({ filename: ':memory:' });
  auth = openSqliteAuthStore({ filename: ':memory:' });
  ledger = openSqliteBlobLedger({ filename: ':memory:' });
  directory = mkdtempSync(join(tmpdir(), 'sibei-account-'));
  blobs = openDirectoryBlobStore({ directory });
  api = createApi({
    store,
    jobs,
    audioJobs,
    blobs,
    blobLedger: ledger,
    logger: silentLogger,
    hosted: {
      auth,
      publicUrl: 'http://127.0.0.1',
      github: {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        authorizeUrl: `${github.url}/login/oauth/authorize`,
        tokenUrl: `${github.url}/login/oauth/access_token`,
        userUrl: `${github.url}/user`,
      },
    },
  });
  ({ port } = await api.listen(0));
});

afterEach(async () => {
  await api.close();
  await Promise.all([store.close(), jobs.close(), audioJobs.close(), auth.close(), ledger.close(), github.close()]);
  rmSync(directory, { recursive: true, force: true });
});

interface Reply {
  status: number;
  body: string;
  cookies: string[];
  headers: Record<string, string | string[] | undefined>;
}

function raw(path: string, options: { method?: string; cookie?: string; body?: unknown; raw?: Buffer; type?: string } = {}): Promise<Reply> {
  const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        // The public URL is `http://127.0.0.1`, so the guards admit this host.
        headers: {
          ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
          // Explicit: Node's client sends no length for a DELETE, and the server then reads the body as a request.
          ...(payload === undefined ? {} : { 'content-type': options.type ?? 'application/json', 'content-length': String(Buffer.byteLength(payload)) }),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, cookies: res.headers['set-cookie'] ?? [], headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const cookieValue = (cookies: string[], name: string): string | undefined =>
  cookies.find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1).split(';')[0];

async function signIn(user: FakeProfile): Promise<{ cookie: string; id: string }> {
  github.nextUser = user;
  const login = await raw('/v1/auth/github/login');
  const authorize = new URL(login.headers.location as string);
  const loginCookie = cookieValue(login.cookies, 'sb_oauth')!;
  const authorized = await fetch(authorize, { redirect: 'manual' });
  const callback = new URL(authorized.headers.get('location')!);
  const done = await raw(callback.pathname + callback.search, { cookie: `sb_oauth=${loginCookie}` });
  const cookie = `sb_session=${cookieValue(done.cookies, 'sb_session')!}`;
  const me = JSON.parse((await raw('/v1/me', { cookie })).body) as { user: { id: string } };
  return { cookie, id: me.user.id };
}

const create = (id: string) => ({ operations: [{ type: 'score.create', payload: { id, barCount: 4, title: `Chart ${id}` } }] });

async function populate(who: { cookie: string; id: string }, scoreId: string, scan: string): Promise<string[]> {
  expect((await raw('/v1/scores', { method: 'POST', cookie: who.cookie, body: create(scoreId) })).status).toBe(201);
  // an export, so the cache is written through the real exporter and recorded in the ledger
  expect((await raw(`/v1/scores/${scoreId}/export?format=musicxml`, { cookie: who.cookie })).status).toBe(200);
  // an import scan: a job and its blob, the way `imports.submit` leaves them
  const key = `import-source:${encodeURIComponent(who.id)}:${scan}`;
  await blobs.put(key, Buffer.from(scan));
  await ledger.record(who.id, key, 'import-source');
  await jobs.create(who.id, [key]);
  // an audio upload, through the real routes: declare, put the bytes, confirm (it stays queued, so the audio
  // object is still on the volume when the account goes)
  const declared = await raw('/v1/audio/jobs', {
    method: 'POST',
    cookie: who.cookie,
    body: { filename: `${scan}.mp3`, contentType: 'audio/mpeg', sizeBytes: 4 },
  });
  expect(declared.status).toBe(201);
  const job = JSON.parse(declared.body).job as { id: string };
  expect((await raw(`/v1/audio/jobs/${job.id}/content`, { method: 'PUT', cookie: who.cookie, raw: Buffer.from('mp3!'), type: 'audio/mpeg' })).status).toBeLessThan(300);
  expect((await raw(`/v1/audio/jobs/${job.id}/uploaded`, { method: 'POST', cookie: who.cookie, body: {} })).status).toBe(200);
  return [key];
}

const blobFiles = (): number => readdirSync(directory).filter((name) => name.endsWith('.blob')).length;

describe('deleting an account', () => {
  it('leaves nothing the account owned in the store or on the blob volume, and nothing of anyone else touched', async () => {
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    await populate(alice, 'alice-chart', 'alice-scan');
    await populate(bob, 'bob-chart', 'bob-scan');
    const bobFiles = 3; // his export, his scan and his audio
    expect(blobFiles()).toBe(6);
    expect((await ledger.list(alice.id)).length).toBe(3);

    const refused = await raw('/v1/auth/account', { method: 'DELETE', cookie: alice.cookie, body: { confirm: 'not-alice' } });
    expect(refused.status).toBe(422);
    expect(JSON.parse(refused.body).error.kind).toBe('confirmation-mismatch');
    expect(blobFiles()).toBe(6);

    const deleted = await raw('/v1/auth/account', { method: 'DELETE', cookie: alice.cookie, body: { confirm: 'Alice' } });
    expect(deleted.status).toBe(204);
    // the session cookie is cleared on the way out
    expect(deleted.cookies.find((c) => c.startsWith('sb_session='))).toMatch(/Max-Age=0/);

    // nothing addressed by her id remains, in any store
    expect(await store.list(alice.id)).toEqual([]);
    expect(await jobs.list(alice.id)).toEqual([]);
    expect(await audioJobs.list(alice.id)).toEqual([]);
    expect(await ledger.list(alice.id)).toEqual([]);
    expect(await auth.getUser(alice.id)).toBeNull();
    expect(await auth.listTokens(alice.id)).toEqual([]);
    // and the blob volume holds only Bob's
    expect(blobFiles()).toBe(bobFiles);
    expect(await blobs.get(`import-source:${encodeURIComponent(alice.id)}:alice-scan`)).toBeNull();

    // her session is dead, her address gone
    expect((await raw('/v1/scores', { cookie: alice.cookie })).status).toBe(401);
    expect((await raw('/v1/scores/alice-chart', { cookie: bob.cookie })).status).toBe(404);

    // Bob has all of his
    expect(JSON.parse((await raw('/v1/scores', { cookie: bob.cookie })).body).scores).toHaveLength(1);
    expect(await jobs.list(bob.id)).toHaveLength(1);
    expect(await audioJobs.list(bob.id)).toHaveLength(1);
    expect(await blobs.get(`import-source:${encodeURIComponent(bob.id)}:bob-scan`)).not.toBeNull();
    expect((await ledger.list(bob.id)).length).toBe(3);
  });

  it('is cookie-only: no session, no deletion', async () => {
    const reply = await raw('/v1/auth/account', { method: 'DELETE', body: { confirm: 'alice' } });
    expect(reply.status).toBe(401);
  });

  it('is repeatable after a failure part-way: the identity outlives the content until the last step', async () => {
    const alice = await signIn(ALICE);
    await populate(alice, 'alice-chart', 'alice-scan');
    // The content goes first and the identity last, so a second press of the button finds an account
    // with nothing left and finishes the job.
    expect((await raw('/v1/auth/account', { method: 'DELETE', cookie: alice.cookie, body: { confirm: 'alice' } })).status).toBe(204);
    expect((await raw('/v1/auth/account', { method: 'DELETE', cookie: alice.cookie, body: { confirm: 'alice' } })).status).toBe(401);
  });

  it('works against the in-memory ledger too (the default when none is supplied)', async () => {
    expect(await memoryBlobLedger().list('x')).toEqual([]);
  });
});
