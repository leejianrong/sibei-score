import type { BlobKey, BlobStore } from './blob-store.js';

/**
 * The blob port over a `Map`. The `:memory:` of blobs.
 *
 * This is what `createApi` falls back to, so a cache exists for the life of the process without
 * anybody having to name a directory, and it is what the tests run against for the same reason
 * the store tests run against `:memory:` — the contract is the port's, not the medium's, and
 * `tests/integration/blob-store.test.ts` runs one table of assertions against both.
 *
 * Copies on the way in and on the way out. A caller that kept its buffer and wrote through it
 * would otherwise be editing the cache, which no real implementation would let it do.
 */
export function memoryBlobStore(): BlobStore {
  const blobs = new Map<BlobKey, Buffer>();
  return {
    get(key) {
      const found = blobs.get(key);
      return Promise.resolve(found === undefined ? null : Buffer.from(found));
    },
    put(key, bytes) {
      blobs.set(key, Buffer.from(bytes));
      return Promise.resolve();
    },
  };
}
