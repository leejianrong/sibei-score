import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * No adapter, no SvelteKit, no router package. The shell is two views and a hash, and
 * ADR-0022 chose Svelte for the shell precisely because the shell is all it has to do —
 * the model, the layout engine and the engraver are framework-free and do the work.
 */
export default { preprocess: vitePreprocess() };
