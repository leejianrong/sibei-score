import type { ServerResponse } from 'node:http';

/**
 * Serving the built browser UI from the same origin as the API (V8g).
 *
 * In development the Vite dev server serves the app and proxies `/v1/` to here; a shipped container
 * has no Vite, so the API serves the built bundle itself — which is what lets the browser talk to
 * `/v1/` same-origin, exactly the arrangement ADR-0029's Origin/Host guards assume. `sbscore serve`
 * had no static path before this; the gap was booked in `agent_docs/history.md`.
 *
 * **This file names no filesystem.** ADR-0006's seam (`tests/arch/blob-seam.test.ts`) keeps every
 * filesystem import in `packages/api` to the one blob adapter, so the bytes arrive through an
 * `AssetSource` port and the fs-backed reader lives in `packages/cli` (which may name a path — a
 * store or a UI directory is a legitimate CLI argument). The port is also what a test injects a fake
 * bundle through, without a directory.
 */

export interface Asset {
  bytes: Uint8Array;
  /** A full `Content-Type`, charset included where it matters. */
  contentType: string;
}

/** A read-only view of a built UI bundle, keyed by request path (`/`, `/assets/app-abc.js`). */
export interface AssetSource {
  /** The asset for a request path, or null when there is nothing to serve for it. */
  asset(path: string): Asset | null;
}

/**
 * Serve a static asset, or return null when the source has nothing for this path so routing can fall
 * through to a 404. A GET only — the caller gates on the method and on the path not being `/v1/…`,
 * so the API surface is never shadowed by a file.
 */
export function serveStaticAsset(
  response: ServerResponse,
  assets: AssetSource,
  path: string,
): number | null {
  const found = assets.asset(path);
  if (found === null) return null;

  response.writeHead(200, {
    'content-type': found.contentType,
    'content-length': found.bytes.length,
    // The same header the JSON and PDF responses carry: a browser must not sniff a type of its own.
    'x-content-type-options': 'nosniff',
  });
  response.end(Buffer.from(found.bytes));
  return 200;
}
