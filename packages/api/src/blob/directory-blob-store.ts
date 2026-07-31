import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BlobKey, BlobStore } from './blob-store.js';

/**
 * The local-directory implementation of the blob port (ADR-0006).
 *
 * **This is the only file in `packages/api` that knows a filesystem exists**, and
 * `tests/arch/blob-seam.test.ts` holds it to that. Same argument as the SQLite port one layer
 * down: the whole point of the interface is that hosting swaps this file for an S3 client and
 * touches nothing else, and that claim survives only while nothing above it reaches for a path.
 *
 * **The filename is the SHA-256 of the key, not the key.** A key carries a score id, and a score
 * id is whatever the client chose — it can hold a slash, a `..`, a NUL, or three hundred
 * characters, and none of those is a filename. Hashing gives a name that is safe *and* bounded
 * through one code path, rather than a sanitiser plus a length cap plus an argument about which
 * characters are acceptable on which platform. Nothing is lost: this is a cache, not a library,
 * and nobody needs to browse it.
 */

export interface DirectoryBlobStoreOptions {
  /** Created if it is not there. A temp directory for a test, a data directory for the real thing. */
  directory: string;
}

const SUFFIX = '.blob';

export function openDirectoryBlobStore(options: DirectoryBlobStoreOptions): BlobStore {
  mkdirSync(options.directory, { recursive: true });

  function fileFor(key: BlobKey): string {
    return join(options.directory, `${createHash('sha256').update(key, 'utf8').digest('hex')}${SUFFIX}`);
  }

  return {
    async get(key) {
      try {
        return await readFile(fileFor(key));
      } catch (error) {
        // A miss is the ordinary case on a cold cache, so it is a null rather than a throw.
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async put(key, bytes) {
      // Write beside, then rename. A reader running against a writer sees the old bytes or the
      // new ones and never half a PDF, and rename is atomic within a directory on every platform
      // this runs on. Two writers racing is harmless anyway — the key names the version the
      // artefact was rendered from (Q81), so they are producing identical bytes.
      const target = fileFor(key);
      const scratch = `${target}.${process.pid}.partial`;
      await writeFile(scratch, bytes);
      await rename(scratch, target);
    },
  };
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
  );
}
