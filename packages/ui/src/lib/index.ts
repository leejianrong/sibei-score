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
export * from './bar-hit.js';
export * from './branding.js';
export * from './chord-hit.js';
export * from './clipboard.js';
export * from './consent.js';
export * from './devices.js';
export * from './events.js';
export * from './format.js';
export * from './hit-test.js';
export * from './lanes.js';
export * from './note-input.js';
export * from './render.js';
export * from './routing.js';
export * from './selection.js';
export * from './keymap.js';
export * from './session.js';
export * from './slur-edits.js';
export * from './staff-edits.js';
export * from './structure-edits.js';
export * from './announce.js';
