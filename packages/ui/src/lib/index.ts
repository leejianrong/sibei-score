/**
 * `@sibei/ui`'s importable surface: the framework-free half.
 *
 * Everything here is plain TypeScript — the render composition, the `/v1/` client, the display
 * formatting, the routes. The Svelte components live beside it under `src/components` and are
 * **not** exported, because nothing outside the browser has any use for them and because
 * `tests/integration/browser-and-server-agree.test.ts` has to import the render path without
 * pulling a component compiler into the fast layer.
 */
export * from './api.js';
export * from './branding.js';
export * from './format.js';
export * from './render.js';
export * from './routing.js';
