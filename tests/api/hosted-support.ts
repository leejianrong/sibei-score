import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { createApi, memoryBlobStore } from '@sibei/api';
import type { Api, AuthStore, JobStore, ScoreStore } from '@sibei/api';
import { openSqliteAuthStore, openSqliteJobStore, openSqliteStore } from '@sibei/api/sqlite';

/**
 * A hosted API on a real socket, for the suites that are about what happens *after* sign-in (V22a: the OAuth
 * server for MCP, and `/mcp` itself). `hosted-auth.test.ts` walks the GitHub flow against a fake GitHub; these
 * suites do not re-prove it, they start where it ends — a user with a live session — by writing the session
 * straight into the auth store, which is exactly the row the callback writes.
 */

export interface Reply {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
  json: () => any;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  host?: string;
}

export interface Hosted {
  api: Api;
  store: ScoreStore;
  jobs: JobStore;
  auth: AuthStore;
  port: number;
  base: string;
  /** `sb_session=…` for a freshly created user: the cookie a signed-in browser sends. */
  signIn(login: string): Promise<{ cookie: string; userId: string }>;
  request(path: string, options?: RequestOptions): Promise<Reply>;
  close(): Promise<void>;
}

export async function startHosted(): Promise<Hosted> {
  const store = openSqliteStore({ filename: ':memory:' });
  const jobs = openSqliteJobStore({ filename: ':memory:' });
  const auth = openSqliteAuthStore({ filename: ':memory:' });
  const api = createApi({
    store,
    jobs,
    blobs: memoryBlobStore(),
    logger: { request: () => {}, error: () => {} },
    hosted: {
      auth,
      publicUrl: 'http://127.0.0.1',
      github: { clientId: 'unused', clientSecret: 'unused' },
    },
  });
  const { port } = await api.listen(0);

  function request(path: string, options: RequestOptions = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: options.method ?? 'GET',
          headers: { host: options.host ?? `127.0.0.1:${port}`, ...options.headers },
          setHost: false,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }),
          );
        },
      );
      req.on('error', reject);
      req.end(options.body);
    });
  }

  let counter = 0;
  return {
    api,
    store,
    jobs,
    auth,
    port,
    base: `http://127.0.0.1:${port}`,
    request,
    async signIn(login) {
      const user = await auth.signIn({ provider: 'github', subject: `${login}-${++counter}`, login, name: null });
      const token = randomBytes(24).toString('base64url');
      await auth.createSession(createHash('sha256').update(token).digest('hex'), user.id, '2999-01-01T00:00:00.000Z');
      return { cookie: `sb_session=${token}`, userId: user.id };
    },
    async close() {
      await api.close();
      await store.close();
      await jobs.close();
      await auth.close();
    },
  };
}

/** A PKCE pair, as a client makes one. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
