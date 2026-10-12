import {
  ApiError,
  OfflineError,
  RETURN_KEY,
  SIGN_IN_PATH,
  afterUnauthenticated,
  displayName,
  initialOf,
  listScores,
  loadSession,
  onSessionEnded,
  rememberReturn,
  signOut,
  takeReturn,
} from '@sibei/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Who is using the browser (V20b). The shell's whole account behaviour is this module plus three
 * components that only draw it, so what matters is pinned here without a browser: how `GET /v1/me` is
 * read, which answers are "signed out" rather than "broken", and when a 401 means a session ended.
 */

function answer(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body === null ? null : JSON.stringify(body), { status })),
  );
}

const ALICE = { id: 'usr_1', login: 'alice', name: 'Alice A' };
const UNAUTHENTICATED = { error: { kind: 'unauthenticated', message: 'not a principal this server knows' } };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadSession reads GET /v1/me', () => {
  it('is local on a local install, where there is nobody to sign in', async () => {
    answer(200, { mode: 'local' });
    await expect(loadSession()).resolves.toEqual({ phase: 'local' });
  });

  it('is signed in, carrying the account, for a live hosted session', async () => {
    answer(200, { mode: 'hosted', user: ALICE });
    await expect(loadSession()).resolves.toEqual({ phase: 'signed-in', account: ALICE });
  });

  it('is signed out on a 401, which is an answer and not a failure', async () => {
    answer(401, UNAUTHENTICATED);
    await expect(loadSession()).resolves.toEqual({ phase: 'signed-out' });
  });

  it('does not guess "signed out" when the server cannot be reached', async () => {
    // A sign-in gate over a dead API would send someone to a link that cannot work.
    answer(500, null);
    await expect(loadSession()).rejects.toBeInstanceOf(OfflineError);
  });

  it('lets any other API refusal through rather than reading it as signed out', async () => {
    answer(403, { error: { kind: 'foreign-host', message: 'no' } });
    await expect(loadSession()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('a 401 while the app is open', () => {
  it('ends a signed-in session and keeps the account, so the banner can say whose', () => {
    expect(afterUnauthenticated({ phase: 'signed-in', account: ALICE })).toEqual({ phase: 'ended', account: ALICE });
  });

  it.each([{ phase: 'checking' }, { phase: 'local' }, { phase: 'signed-out' }] as const)(
    'changes nothing for %o, because there was no session to end',
    (session) => {
      expect(afterUnauthenticated(session)).toBe(session);
    },
  );

  it('is reported once per 401 from the one place every failure passes, and only for a 401', async () => {
    const heard = vi.fn();
    const stop = onSessionEnded(heard);
    answer(404, { error: { kind: 'no-such-score', message: 'no' } });
    await listScores().catch(() => undefined);
    expect(heard).not.toHaveBeenCalled();

    answer(401, UNAUTHENTICATED);
    await listScores().catch(() => undefined);
    expect(heard).toHaveBeenCalledTimes(1);

    stop();
    await listScores().catch(() => undefined);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('signing in and out', () => {
  it('signs in by navigation to the server, not by fetch, so no GitHub code or token enters the bundle', () => {
    expect(SIGN_IN_PATH).toBe('/v1/auth/github/login');
  });

  it('signs out with a POST to the logout route', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);
    await signOut();
    const [path, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/v1/auth/logout');
    expect(init.method).toBe('POST');
  });
});

describe('keeping the place across the sign-in round trip', () => {
  function shelf(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { held: Map<string, string> } {
    const held = new Map<string, string>();
    return {
      held,
      getItem: (key) => held.get(key) ?? null,
      setItem: (key, value) => void held.set(key, value),
      removeItem: (key) => void held.delete(key),
    };
  }

  it('gives back the chart that was open, once', () => {
    const s = shelf();
    rememberReturn('#/score/body-and-soul', s);
    expect(takeReturn(s)).toBe('#/score/body-and-soul');
    expect(takeReturn(s)).toBeNull();
  });

  it('keeps an encoded id intact', () => {
    const s = shelf();
    rememberReturn('#/score/caf%C3%A9', s);
    expect(takeReturn(s)).toBe('#/score/caf%C3%A9');
  });

  it('remembers nothing for the library, and clears an older bookmark', () => {
    const s = shelf();
    rememberReturn('#/score/old', s);
    rememberReturn('', s);
    expect(takeReturn(s)).toBeNull();
  });

  it('refuses anything that is not an in-app route, so a stored value cannot send anyone elsewhere', () => {
    for (const bad of ['https://evil.example/', '//evil.example', '#javascript:alert(1)', '#/score/<script>']) {
      const s = shelf();
      s.setItem(RETURN_KEY, bad);
      expect({ bad, got: takeReturn(s) }).toEqual({ bad, got: null });
    }
  });

  it('is quiet when storage throws, as it does with blocked site data', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => rememberReturn('#/score/x', broken)).not.toThrow();
    expect(takeReturn(broken)).toBeNull();
  });
});

describe('how an account is named', () => {
  it('shows the real name when there is one, and the handle when there is not', () => {
    expect(displayName(ALICE)).toBe('Alice A');
    expect(displayName({ ...ALICE, name: null })).toBe('alice');
    expect(displayName({ ...ALICE, name: '   ' })).toBe('alice');
  });

  it('takes the avatar letter from the handle, in capitals, and survives an odd one', () => {
    expect(initialOf(ALICE)).toBe('A');
    expect(initialOf({ ...ALICE, login: '  zoë' })).toBe('Z');
    expect(initialOf({ ...ALICE, login: '😀dev' })).toBe('😀');
    expect(initialOf({ ...ALICE, login: '' })).toBe('?');
  });
});
