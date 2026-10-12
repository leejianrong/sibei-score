import { ApiError, getMe } from './api.js';

/**
 * What the shell knows about who is using it (V20b). Plain TypeScript, so the transitions can be tested
 * without a browser; `App.svelte` only holds the value and draws it.
 *
 * Five phases, and every one of them has a distinct screen:
 *
 *   checking    `GET /v1/me` has not answered yet. Nothing account-shaped is drawn, so a signed-in
 *               person is never flashed a sign-in gate.
 *   local       a local install. No accounts exist, so no gate and no chip: today's app, unchanged.
 *   signed-out  hosted, and there is no live session. The sign-in gate replaces the app.
 *   signed-in   hosted, with an account to name in the top bar.
 *   ended       a request came back 401 while the app was open. What was on screen stays, readable,
 *               under a banner; nothing is retried silently.
 */

export interface Account {
  id: string;
  login: string;
  name: string | null;
}

export type Session =
  | { phase: 'checking' }
  | { phase: 'local' }
  | { phase: 'signed-out' }
  | { phase: 'signed-in'; account: Account }
  | { phase: 'ended'; account: Account | null };

export const CHECKING: Session = { phase: 'checking' };

/**
 * Ask the server who this is. A 401 is the answer "nobody", not a failure. Anything else (the server
 * is not running, a 500) is left to throw: the library view already has an honest screen for an
 * unreachable API, and guessing "signed out" over it would send someone to a sign-in that cannot work.
 */
export async function loadSession(): Promise<Session> {
  try {
    const me = await getMe();
    if (me.mode === 'local') return { phase: 'local' };
    return me.user === undefined ? { phase: 'signed-out' } : { phase: 'signed-in', account: me.user };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return { phase: 'signed-out' };
    throw error;
  }
}

/**
 * A 401 arrived somewhere in the app. Only a session that was signed in can *end*: a 401 while still
 * checking is the check itself saying "signed out", and one on the gate is the gate being right.
 */
export function afterUnauthenticated(session: Session): Session {
  return session.phase === 'signed-in' ? { phase: 'ended', account: session.account } : session;
}

/** The name to show: a real name when GitHub gave one, otherwise the handle. */
export function displayName(account: Account): string {
  return account.name !== null && account.name.trim() !== '' ? account.name : account.login;
}

/** One letter for the avatar. The handle, not the name, so it matches what the chip beside it says. */
export function initialOf(account: Account): string {
  const first = [...account.login.trim()][0];
  return first === undefined ? '?' : first.toUpperCase();
}

/**
 * Sign-in is a full-page trip to GitHub and back, and the server sends the browser home (`/`) when it
 * is done, which drops the `#/score/…` fragment. So the place a person was is kept for the round trip
 * and put back after, which is what lets "Sign in again" return to the chart rather than to the library.
 * The storage is passed in so a test can use a plain object; `sessionStorage` can throw (blocked site
 * data), and a lost bookmark is a missing convenience, never an error.
 */
export const RETURN_KEY = 'sbscore.return';

type Shelf = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function rememberReturn(hash: string, shelf: Shelf): void {
  try {
    if (hash === '' || hash === '#') shelf.removeItem(RETURN_KEY);
    else shelf.setItem(RETURN_KEY, hash);
  } catch {
    // no bookmark; the person lands in the library
  }
}

/** The remembered place, once. Only an in-app route is honoured, so a stored value cannot send anyone elsewhere. */
export function takeReturn(shelf: Shelf): string | null {
  try {
    const hash = shelf.getItem(RETURN_KEY);
    shelf.removeItem(RETURN_KEY);
    return hash !== null && /^#\/[A-Za-z0-9._~%/-]*$/.test(hash) ? hash : null;
  } catch {
    return null;
  }
}
