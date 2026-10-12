import type { Id } from '@sibei/model';

/**
 * Two routes and a hash. No router package: ADR-0022 chose Svelte for the shell because the
 * shell is small, and a second dependency for `#/score/<id>` would be the opposite of that.
 *
 * The hash rather than the History API because the built UI is static and there is nothing
 * serving a fallback for a deep path yet.
 */

export type Route =
  | { view: 'library' }
  | { view: 'score'; id: Id }
  /** Approve the code a CLI printed (V21b). The address `sbscore auth login` tells a person to open. */
  | { view: 'device' }
  /** The caller's API tokens, to look at and revoke (V21b). */
  | { view: 'tokens' };

export const LIBRARY: Route = { view: 'library' };
export const DEVICE: Route = { view: 'device' };
export const TOKENS: Route = { view: 'tokens' };

export function routeOf(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  if (path === 'device') return DEVICE;
  if (path === 'tokens') return TOKENS;
  const id = /^score\/(.+)$/.exec(path)?.[1];
  return id === undefined || id === '' ? LIBRARY : { view: 'score', id: decodeURIComponent(id) };
}

export function hashOf(route: Route): string {
  switch (route.view) {
    case 'library':
      return '#/';
    case 'device':
      return '#/device';
    case 'tokens':
      return '#/tokens';
    case 'score':
      return `#/score/${encodeURIComponent(route.id)}`;
  }
}
