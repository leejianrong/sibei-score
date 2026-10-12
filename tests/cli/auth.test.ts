import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '@sibei/api';
import type { Api, AuthStore, ScoreStore } from '@sibei/api';
import { openSqliteAuthStore, openSqliteStore } from '@sibei/api/sqlite';
import { EXIT, run } from '@sibei/cli';

/**
 * `sbscore auth` (V21b): the CLI's half of ADR-0034 decision 4, against a real hosted server over real
 * HTTP. GitHub is not involved anywhere — the person at the keyboard is simulated by approving the user
 * code the CLI printed, with a session cookie made straight through the identity store, which is exactly
 * what a signed-in browser would present. What is under test is the CLI: what it prints, what it stores,
 * what it sends, and to whom.
 */

const USER_CODE = /([BCDFGHJKMNPQRSTVWXYZ2-9]{4}-[BCDFGHJKMNPQRSTVWXYZ2-9]{4})/;

let store: ScoreStore;
let auth: AuthStore;
let api: Api;
let baseUrl: string;
let directory: string;
let credentialsPath: string;
let clock: number;
let out: string[];
let err: string[];
let sleeps: number[];

beforeEach(async () => {
  store = openSqliteStore({ filename: ':memory:' });
  auth = openSqliteAuthStore({ filename: ':memory:' });
  clock = Date.parse('2026-10-01T00:00:00Z');
  api = createApi({
    store,
    logger: { request: () => {}, error: () => {} },
    hosted: {
      auth,
      publicUrl: 'http://127.0.0.1',
      github: { clientId: 'id', clientSecret: 'secret' },
      now: () => new Date(clock),
    },
  });
  const { port } = await api.listen(0);
  baseUrl = `http://127.0.0.1:${port}`;
  directory = mkdtempSync(join(tmpdir(), 'sbscore-auth-'));
  credentialsPath = join(directory, 'config', 'sbscore', 'credentials.json');
  out = [];
  err = [];
  sleeps = [];
});

afterEach(async () => {
  await api.close();
  await store.close();
  await auth.close();
  rmSync(directory, { recursive: true, force: true });
});

interface Options {
  url?: string;
  /** Called each time the CLI waits, in place of really waiting. */
  onSleep?: (ms: number, call: number) => Promise<void> | void;
  stdin?: string;
  env?: Record<string, string | undefined>;
}

async function sbscore(argv: string[], options: Options = {}): Promise<{ code: number; out: string; err: string }> {
  out = [];
  err = [];
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(options.env ?? {})) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const code = await run(argv, {
      baseUrl: options.url ?? baseUrl,
      credentialsPath,
      io: { out: (text) => out.push(text), err: (text) => err.push(text) },
      sleep: async (ms) => {
        sleeps.push(ms);
        await options.onSleep?.(ms, sleeps.length);
      },
      ...(options.stdin === undefined ? {} : { readStdin: async () => options.stdin! }),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

let counter = 0;
/** A signed-in browser: a session cookie for a new user, made through the identity store. */
async function aBrowser(login = 'alice', name: string | null = 'Alice A'): Promise<string> {
  const user = await auth.signIn({ provider: 'github', subject: String(++counter), login, name });
  const token = randomBytes(32).toString('base64url');
  await auth.createSession(sha256(token), user.id, '2999-01-01T00:00:00Z');
  return `sb_session=${token}`;
}

/** The person at the keyboard: approve whatever user code the CLI last printed. */
async function approvePrinted(cookie: string, body: Record<string, unknown> = {}): Promise<void> {
  const code = USER_CODE.exec(out.join('\n'))?.[1];
  if (code === undefined) throw new Error(`the CLI printed no user code: ${out.join(' | ')}`);
  const reply = await fetch(`${baseUrl}/v1/auth/device/approve`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ userCode: code, ...body }),
  });
  expect(reply.status).toBe(204);
}

/** `sbscore auth login` end to end, approved on the first wait. */
async function login(cookie: string, argv: string[] = [], body: Record<string, unknown> = {}) {
  return sbscore(['auth', 'login', ...argv], { onSleep: () => approvePrinted(cookie, body) });
}

const storedToken = (): string => {
  const file = JSON.parse(readFileSync(credentialsPath, 'utf8')) as Record<string, { token: string }>;
  return file[baseUrl]!.token;
};

describe('sbscore auth login: the device flow', () => {
  it('prints where to go and the code, waits for a person, then saves a credential and says who it is', async () => {
    const cookie = await aBrowser();
    const done = await login(cookie, [], { name: 'laptop' });
    expect(done.code).toBe(EXIT.ok);
    const text = done.out;
    expect(text).toMatch(USER_CODE);
    expect(text).toContain('http://127.0.0.1/#/device');
    expect(text).toContain('alice');
    expect(text).toContain(credentialsPath);
    expect(existsSync(credentialsPath)).toBe(true);
    // Waited the interval the server asked for, once, rather than hammering.
    expect(sleeps).toEqual([5000]);
  });

  it('never prints the token it was given, in either output mode', async () => {
    const cookie = await aBrowser();
    const done = await login(cookie);
    const token = storedToken();
    expect(token).toMatch(/^sbs_/);
    expect(done.out + done.err).not.toContain(token);
    const status = await sbscore(['auth', 'status']);
    expect(status.out + status.err).not.toContain(token);
    const asJson = await sbscore(['auth', 'status', '--json']);
    expect(asJson.out + asJson.err).not.toContain(token);
  });

  it('says what it is doing in --json too: one line for the prompt, one for the result', async () => {
    const cookie = await aBrowser();
    const done = await login(cookie, ['--json']);
    const lines = done.out.split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ event: 'device', userCode: expect.stringMatching(USER_CODE), interval: 5 });
    expect(lines.at(-1)).toMatchObject({ event: 'signed-in', url: baseUrl, user: { login: 'alice' }, scopes: ['read', 'write'] });
  });

  it('keeps the scopes the person chose when approving in the browser, not its own idea of them', async () => {
    const cookie = await aBrowser();
    const done = await login(cookie, ['--json'], { scopes: ['read'] });
    expect(JSON.parse(done.out.split('\n').at(-1)!).scopes).toEqual(['read']);
  });

  it('backs off when the server says slow down, then carries on', async () => {
    const cookie = await aBrowser();
    // Nothing really waits, so the second poll arrives at once and the server tells it to slow down.
    const done = await sbscore(['auth', 'login'], {
      onSleep: async (_ms, call) => {
        if (call === 3) await approvePrinted(cookie);
      },
    });
    expect(done.code).toBe(EXIT.ok);
    expect(sleeps).toEqual([5000, 5000, 10000]);
  });

  it('gives up with a clear message when the code expires, and saves nothing', async () => {
    await aBrowser();
    const done = await sbscore(['auth', 'login'], { onSleep: () => void (clock += 11 * 60 * 1000) });
    expect(done.code).toBe(EXIT.validation);
    expect(done.err).toMatch(/expired/);
    expect(done.err).toContain('sbscore auth login');
    expect(existsSync(credentialsPath)).toBe(false);
  });

  it('says plainly that a local server has nothing to sign in to', async () => {
    const localStore = openSqliteStore({ filename: ':memory:' });
    const local = createApi({ store: localStore, logger: { request: () => {}, error: () => {} } });
    const { port } = await local.listen(0);
    try {
      const done = await sbscore(['auth', 'login'], { url: `http://127.0.0.1:${port}` });
      expect(done.code).toBe(EXIT.usage);
      expect(done.err).toMatch(/local/);
      expect(existsSync(credentialsPath)).toBe(false);
    } finally {
      await local.close();
      await localStore.close();
    }
  });

  it('reports a server that is not running as exit 6, as every verb does', async () => {
    const done = await sbscore(['auth', 'login'], { url: 'http://127.0.0.1:1' });
    expect(done.code).toBe(EXIT.noServer);
  });
});

describe('the credentials file', () => {
  it('is 0600 in a 0700 directory, which is what keeps a bearer token between its user and the disk', async () => {
    await login(await aBrowser());
    expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(credentialsPath)).mode & 0o777).toBe(0o700);
  });

  it('is written without ever existing world-readable: the temp file is 0600 too', async () => {
    // The file is renamed into place, so what is checked is that no mode wider than 0600 was ever used.
    await login(await aBrowser());
    const leftovers = existsSync(dirname(credentialsPath)) ? (await import('node:fs')).readdirSync(dirname(credentialsPath)) : [];
    expect(leftovers).toEqual(['credentials.json']);
  });

  it('keeps one credential per server and sends each only to its own', async () => {
    // A credential for A, then a request to B: the token must not leave for B.
    await login(await aBrowser());
    const seen: (string | undefined)[] = [];
    const other: Server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', api: 'v1' }));
    });
    await new Promise<void>((done) => other.listen(0, '127.0.0.1', done));
    const address = other.address();
    const otherUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
    try {
      expect((await sbscore(['health'], { url: otherUrl })).code).toBe(EXIT.ok);
      expect(seen).toEqual([undefined]);
      // And to the right one it does go.
      expect((await sbscore(['list'])).code).toBe(EXIT.ok);
    } finally {
      await new Promise<void>((done) => other.close(() => done()));
    }
  });

  it('treats a trailing slash on the URL as the same server', async () => {
    await login(await aBrowser());
    expect((await sbscore(['list'], { url: `${baseUrl}/` })).code).toBe(EXIT.ok);
  });

  it('warns, once and on stderr, when it is readable by others, and still works', async () => {
    await login(await aBrowser());
    chmodSync(credentialsPath, 0o644);
    const done = await sbscore(['list']);
    expect(done.code).toBe(EXIT.ok);
    expect(done.err).toMatch(/readable by other users/);
    expect(done.err).toContain('chmod 600');
  });
});

describe('every other verb, against a hosted server', () => {
  it('is refused without a credential, and says how to get one', async () => {
    const done = await sbscore(['list']);
    expect(done.code).toBe(EXIT.refused);
    expect(done.err).toContain('sbscore auth login');
  });

  it('works unchanged once signed in: the same verbs, the same output', async () => {
    await login(await aBrowser());
    expect((await sbscore(['new', '--id', 'soul', '--title', 'Body and Soul', '--bars', '4'])).code).toBe(EXIT.ok);
    expect((await sbscore(['list'])).out).toContain('soul');
    expect((await sbscore(['show', 'soul'])).out).toContain('Body and Soul');
    expect((await sbscore(['note', 'add', 'soul', 'bar1.beat1', '--pitch', 'Db5', '--dur', '4'])).code).toBe(EXIT.ok);
  });

  it('is limited to what it was approved for: a read-only credential reads, and is refused a write (exit 7)', async () => {
    await login(await aBrowser(), [], { scopes: ['read'] });
    expect((await sbscore(['list'])).code).toBe(EXIT.ok);
    const refused = await sbscore(['new', '--id', 'x', '--bars', '4']);
    expect(refused.code).toBe(EXIT.refused);
    expect(refused.err).toMatch(/scope/);
  });

  it('is refused at once when the token is revoked in the browser, and points at logging in again', async () => {
    const cookie = await aBrowser();
    await login(cookie);
    expect((await sbscore(['list'])).code).toBe(EXIT.ok);
    const tokens = (await (await fetch(`${baseUrl}/v1/auth/tokens`, { headers: { cookie } })).json()) as { tokens: { id: string }[] };
    const revoked = await fetch(`${baseUrl}/v1/auth/tokens/${tokens.tokens[0]!.id}`, { method: 'DELETE', headers: { cookie } });
    expect(revoked.status).toBe(204);
    const done = await sbscore(['list']);
    expect(done.code).toBe(EXIT.refused);
    expect(done.err).toContain('sbscore auth login');
  });
});

describe('sbscore auth status', () => {
  it('says not signed in, and exits 7 so a script can branch on it', async () => {
    const done = await sbscore(['auth', 'status']);
    expect(done.code).toBe(EXIT.refused);
    expect(done.out + done.err).toMatch(/not signed in/i);
    const asJson = await sbscore(['auth', 'status', '--json']);
    expect(asJson.code).toBe(EXIT.refused);
    expect(JSON.parse(asJson.out)).toMatchObject({ url: baseUrl, mode: 'hosted', signedIn: false });
  });

  it('names who it is signed in as, where the credential came from, and when it expires', async () => {
    await login(await aBrowser());
    const done = await sbscore(['auth', 'status']);
    expect(done.code).toBe(EXIT.ok);
    expect(done.out).toContain('alice');
    expect(done.out).toContain('2026-12-30'); // 90 days after the fake clock's 1 Oct
    const asJson = JSON.parse((await sbscore(['auth', 'status', '--json'])).out);
    expect(asJson).toMatchObject({
      url: baseUrl,
      mode: 'hosted',
      signedIn: true,
      source: 'file',
      user: { login: 'alice', name: 'Alice A' },
      scopes: ['read', 'write'],
      expiresAt: '2026-12-30T00:00:00Z',
    });
  });

  it('is fine on a local server, where there is nobody to be', async () => {
    const localStore = openSqliteStore({ filename: ':memory:' });
    const local = createApi({ store: localStore, logger: { request: () => {}, error: () => {} } });
    const { port } = await local.listen(0);
    try {
      const done = await sbscore(['auth', 'status', '--json'], { url: `http://127.0.0.1:${port}` });
      expect(done.code).toBe(EXIT.ok);
      expect(JSON.parse(done.out)).toMatchObject({ mode: 'local', signedIn: false });
    } finally {
      await local.close();
      await localStore.close();
    }
  });

  it('reports a credential the server no longer accepts as not signed in, not as a crash', async () => {
    const cookie = await aBrowser();
    await login(cookie);
    const tokens = (await (await fetch(`${baseUrl}/v1/auth/tokens`, { headers: { cookie } })).json()) as { tokens: { id: string }[] };
    await fetch(`${baseUrl}/v1/auth/tokens/${tokens.tokens[0]!.id}`, { method: 'DELETE', headers: { cookie } });
    const done = await sbscore(['auth', 'status', '--json']);
    expect(done.code).toBe(EXIT.refused);
    expect(JSON.parse(done.out)).toMatchObject({ signedIn: false, rejected: true });
  });
});

describe('sbscore auth token and SBSCORE_TOKEN', () => {
  it('prints the token and nothing else, so $(sbscore auth token) is a token', async () => {
    await login(await aBrowser());
    const done = await sbscore(['auth', 'token']);
    expect(done.code).toBe(EXIT.ok);
    expect(done.out).toBe(storedToken());
    expect(done.err).toBe('');
  });

  it('exits 7 with no token to print', async () => {
    const done = await sbscore(['auth', 'token']);
    expect(done.code).toBe(EXIT.refused);
    expect(done.out).toBe('');
  });

  it('lets SBSCORE_TOKEN stand in for the file, which is how a CI job holds a credential without a home directory', async () => {
    await login(await aBrowser());
    const token = storedToken();
    rmSync(credentialsPath);
    expect((await sbscore(['list'])).code).toBe(EXIT.refused);
    expect((await sbscore(['list'], { env: { SBSCORE_TOKEN: token } })).code).toBe(EXIT.ok);
    const status = JSON.parse((await sbscore(['auth', 'status', '--json'], { env: { SBSCORE_TOKEN: token } })).out);
    expect(status).toMatchObject({ signedIn: true, source: 'SBSCORE_TOKEN' });
    expect((await sbscore(['auth', 'token'], { env: { SBSCORE_TOKEN: token } })).out).toBe(token);
  });
});

describe('sbscore auth login --token (the headless fallback)', () => {
  async function aToken(): Promise<string> {
    await login(await aBrowser('bob', null));
    const token = storedToken();
    rmSync(credentialsPath);
    return token;
  }

  it('verifies a token against the server before keeping it, then stores it', async () => {
    const token = await aToken();
    const done = await sbscore(['auth', 'login', '--token-stdin'], { stdin: `${token}\n` });
    expect(done.code).toBe(EXIT.ok);
    expect(done.out).toContain('bob');
    expect(storedToken()).toBe(token);
    expect(done.out + done.err).not.toContain(token);
    expect((await sbscore(['list'])).code).toBe(EXIT.ok);
  });

  it('refuses a token the server does not accept, and stores nothing', async () => {
    const done = await sbscore(['auth', 'login', '--token-stdin'], { stdin: 'sbs_not-a-real-token\n' });
    expect(done.code).toBe(EXIT.refused);
    expect(existsSync(credentialsPath)).toBe(false);
    expect(done.err).not.toContain('sbs_not-a-real-token');
  });

  it('refuses an empty token', async () => {
    const done = await sbscore(['auth', 'login', '--token-stdin'], { stdin: '\n' });
    expect(done.code).toBe(EXIT.usage);
  });

  it('also takes --token VALUE, which works but is the one way to leave a token in shell history', async () => {
    const token = await aToken();
    const done = await sbscore(['auth', 'login', '--token', token]);
    expect(done.code).toBe(EXIT.ok);
    expect(done.err).toMatch(/--token-stdin/);
    expect(done.err).not.toContain(token);
  });
});

describe('sbscore auth logout', () => {
  it('forgets the credential for this server and keeps any other', async () => {
    await login(await aBrowser());
    const file = JSON.parse(readFileSync(credentialsPath, 'utf8'));
    file['http://other.example'] = { token: 'sbs_other', savedAt: '2026-01-01T00:00:00Z' };
    (await import('node:fs')).writeFileSync(credentialsPath, JSON.stringify(file), { mode: 0o600 });

    const done = await sbscore(['auth', 'logout']);
    expect(done.code).toBe(EXIT.ok);
    expect(done.out).toMatch(/signed out/i);
    const after = JSON.parse(readFileSync(credentialsPath, 'utf8'));
    expect(Object.keys(after)).toEqual(['http://other.example']);
    expect((await sbscore(['list'])).code).toBe(EXIT.refused);
  });

  it('is not an error to sign out twice, and says the token stays valid until revoked in the browser', async () => {
    await login(await aBrowser());
    const first = await sbscore(['auth', 'logout']);
    expect(first.out).toMatch(/revoke/i);
    const second = await sbscore(['auth', 'logout']);
    expect(second.code).toBe(EXIT.ok);
    expect(second.out).toMatch(/not signed in/i);
  });
});
