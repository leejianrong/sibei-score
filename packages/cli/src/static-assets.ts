import { readFileSync, readdirSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import type { AssetSource } from '@sibei/api';

/**
 * The filesystem behind the API's `AssetSource` port (V8g).
 *
 * ADR-0006 keeps the filesystem out of `packages/api` (one blob adapter aside), so the API takes a
 * port and the bytes are read here, in the CLI, where naming a path is a legitimate argument. This
 * is that reader: a directory of built UI files, hoisted into memory once at startup and served by
 * exact request path thereafter.
 *
 * **Read eagerly, not per request, and that is the security decision.** Every file is loaded and
 * keyed by its served path up front, so a request is a `Map` lookup and never touches the disk —
 * which means a crafted path (`/../../etc/passwd`, a `%2e%2e` that decoded to one) has nothing to
 * traverse. It can only hit a key that exists or miss, and a miss is a 404. The bundle is a handful
 * of files and does not change under a running server, so there is nothing to reload and nothing to
 * watch.
 *
 * **No SPA fallback, on purpose.** The browser routes on the URL *hash* (`App.svelte`: `hashOf`,
 * `hashchange`), so every client-side route is `/#/…` and the only paths that ever reach the server
 * are `/` and the hashed asset URLs. A request for `/library` is therefore a genuine miss, not a
 * deep link, and answering it with `index.html` the way a path-routed app would need would only
 * mask real 404s. So `/` serves `index.html` and everything else serves its own file or nothing.
 */
export function loadAssets(directory: string): AssetSource {
  const assets = new Map<string, { bytes: Uint8Array; contentType: string }>();

  for (const relative of filesUnder(directory)) {
    // The served path: forward slashes and a leading one, whatever the host's separator is.
    const served = '/' + relative.split(sep).join('/');
    const bytes = readFileSync(join(directory, relative));
    assets.set(served, { bytes, contentType: contentTypeFor(served) });
  }

  // `/` is `index.html`. Kept as a second key onto the same asset rather than rewritten at request
  // time, so the lookup stays a single `get` with no path massaging in the hot path.
  const index = assets.get('/index.html');
  if (index !== undefined) assets.set('/', index);

  return {
    asset(path) {
      return assets.get(path) ?? null;
    },
  };
}

/** Every file under a directory, as paths relative to it. A plain recursive walk — no globbing. */
function filesUnder(directory: string): string[] {
  const found: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const next = relative === '' ? entry.name : posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) found.push(next);
    }
  };
  walk('');
  return found;
}

/**
 * The `Content-Type` for a served path, by extension. A small fixed table rather than a dependency:
 * a Vite lead-sheet bundle is HTML, JS, CSS, a font and a handful of images, and a type the table
 * does not know falls back to `application/octet-stream` — a download, never a guessed executable,
 * which is the safe direction to be wrong in (the responses also carry `nosniff`).
 */
function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  const extension = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json',
};
