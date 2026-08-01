import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

/**
 * The dev server, and the one thing about it that is a decision rather than a default.
 *
 * **`/v1` is proxied, not fetched cross-origin.** ADR-0029 sends no CORS headers at all — not
 * even a wildcard, and `tests/arch` greps the tree for one — so a page on the dev server's port
 * simply cannot read a response from the API's port. The fix is to be same-origin: the dev
 * server forwards `/v1/*` to the API and the browser only ever talks to itself.
 *
 * That is the ADR working as intended rather than something to route around. It is explicit that
 * the guards had to land *before* a working client existed, or they would get loosened to make
 * one pass; this is the first client, and nothing was loosened.
 *
 * `SBSCORE_API` overrides the target for a server started on another port
 * (`sbscore serve --port N`). The prefix matches `SBSCORE_URL` and `SBSCORE_DATA` on the CLI
 * (D67) — a dev-server variable in a different family would be one more thing to remember.
 */
const API = process.env['SBSCORE_API'] ?? 'http://127.0.0.1:4321';

/** Loopback, and never `0.0.0.0`, for the same reason the API binds loopback (ADR-0029). */
const HOST = '127.0.0.1';

export default defineConfig({
  plugins: [svelte()],
  define: {
    // What the top bar names as the server it is talking to. Derived from the proxy target so
    // the label cannot claim one host while the requests go to another.
    __API_LABEL__: JSON.stringify(new URL(API).host),
  },
  server: {
    host: HOST,
    port: 5173,
    strictPort: true,
    proxy: { '/v1': { target: API, changeOrigin: true } },
  },
  preview: {
    host: HOST,
    port: 4173,
    strictPort: true,
    proxy: { '/v1': { target: API, changeOrigin: true } },
  },
  build: { outDir: 'dist', target: 'es2022' },
});
