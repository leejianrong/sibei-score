/// <reference types="svelte" />
/// <reference types="vite/client" />

/**
 * The API host the top bar names, substituted by `vite.config.ts` from the proxy target so the
 * label cannot claim one host while the requests go to another.
 */
declare const __API_LABEL__: string;
