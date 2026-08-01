import type { Id } from '@sibei/model';

/**
 * Two routes and a hash. No router package: ADR-0022 chose Svelte for the shell because the
 * shell is small, and a second dependency for `#/score/<id>` would be the opposite of that.
 *
 * The hash rather than the History API because the built UI is static and there is nothing
 * serving a fallback for a deep path yet.
 */

export type Route = { view: 'library' } | { view: 'score'; id: Id };

export const LIBRARY: Route = { view: 'library' };

export function routeOf(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const id = /^score\/(.+)$/.exec(path)?.[1];
  return id === undefined || id === '' ? LIBRARY : { view: 'score', id: decodeURIComponent(id) };
}

export function hashOf(route: Route): string {
  return route.view === 'library' ? '#/' : `#/score/${encodeURIComponent(route.id)}`;
}
