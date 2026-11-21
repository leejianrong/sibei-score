import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

/**
 * A fake GitHub that behaves like the real one where it matters: a real HTTP server that issues
 * single-use authorization codes bound to the PKCE challenge it was shown at `/authorize`, and refuses the
 * token exchange when the client secret, the redirect URI or the verifier is wrong. The V20 suite
 * (`tests/api/hosted-auth.test.ts`) grew it inline; this is the same thing as a reusable fixture, for the
 * account-deletion suite and the V24 compose smoke test (`scripts/smoke-hosted.sh` drives it through
 * `scripts/fake-github.ts`).
 *
 * `/authorize` signs in `nextUser` at once, standing in for whoever is at the keyboard.
 */
export interface FakeProfile {
  id: number;
  login: string;
  name: string | null;
}

export interface FakeGitHub {
  url: string;
  nextUser: FakeProfile;
  close(): Promise<void>;
}

export interface FakeGitHubOptions {
  clientId: string;
  clientSecret: string;
  /** Port to listen on (0 = any), and address (default loopback). */
  port?: number;
  host?: string;
}

export async function startFakeGitHub(options: FakeGitHubOptions): Promise<FakeGitHub> {
  const codes = new Map<string, { challenge: string; redirectUri: string; user: FakeProfile }>();
  const tokens = new Map<string, FakeProfile>();
  let counter = 0;

  const fake: FakeGitHub = {
    url: '',
    nextUser: { id: 1, login: 'tester', name: null },
    close: () => new Promise((done) => server.close(() => done())),
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url.pathname === '/login/oauth/authorize') {
      const challenge = url.searchParams.get('code_challenge');
      const redirectUri = url.searchParams.get('redirect_uri');
      if (url.searchParams.get('client_id') !== options.clientId || challenge === null || redirectUri === null) {
        return json(400, { error: 'bad authorize request' });
      }
      const code = `code-${++counter}`;
      codes.set(code, { challenge, redirectUri, user: fake.nextUser });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const form = new URLSearchParams(raw);
        const code = form.get('code') ?? '';
        const issued = codes.get(code);
        codes.delete(code);
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (
          issued === undefined ||
          form.get('client_id') !== options.clientId ||
          form.get('client_secret') !== options.clientSecret ||
          form.get('redirect_uri') !== issued.redirectUri ||
          challenge !== issued.challenge
        ) {
          return json(200, { error: 'bad_verification_code' });
        }
        const accessToken = `gho_fake_${++counter}`;
        tokens.set(accessToken, issued.user);
        json(200, { access_token: accessToken, token_type: 'bearer', scope: 'read:user' });
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/user') {
      const user = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (user === undefined) return json(401, { message: 'Bad credentials' });
      return json(200, user);
    }
    json(404, {});
  });

  await new Promise<void>((done) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  fake.url = `http://${options.host ?? '127.0.0.1'}:${address.port}`;
  return fake;
}
