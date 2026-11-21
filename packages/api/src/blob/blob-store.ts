/**
 * The blob port (ADR-0006).
 *
 * ADR-0006 puts binary artefacts — source images, exported PDFs — in a local directory behind a
 * `BlobStore` interface, for exactly the reason the scores went behind a repository: the hosted
 * transition is then a change of implementation and not a rewrite (R8, ADR-0001). An
 * S3-compatible backend becomes a second implementation of this interface rather than an edit to
 * everything that was calling it. `tests/arch/blob-seam.test.ts` asserts that, because
 * "swappable" stays true only for as long as somebody is checking.
 *
 * **Asynchronous, unlike the store port.** `ScoreReader` is synchronous because SQLite is, and
 * the swap it anticipates is to a driver that is not — a debt already on the books. There is no
 * reason to take the same one twice: the blob backend worth swapping to is across a network, and
 * a port that cannot express waiting would have to be rewritten the day it was used for its
 * purpose.
 */

/**
 * An opaque cache key. An implementation must treat it as a *name* and never as a path — a key
 * carries a score id, and a score id is whatever the client chose it to be.
 */
export type BlobKey = string;

/**
 * Two methods, and deliberately no `delete`.
 *
 * Q81's cache is keyed by `(score version, format, instrument)`, so a version bump invalidates
 * implicitly and **there is no invalidation logic** — invalidation logic being the thing that
 * gets it wrong. Offering a delete here would be offering somewhere to write some. The
 * consequence is that superseded artefacts accumulate; eviction is a housekeeping job for
 * whoever needs one, not a correctness concern, because a stale key is never read again.
 */
export interface BlobStore {
  /** The bytes, or null when there are none under that key. A miss is ordinary, not an error. */
  get(key: BlobKey): Promise<Buffer | null>;
  put(key: BlobKey, bytes: Buffer): Promise<void>;
}

/**
 * What a blob has to offer once a *lifetime* matters (ADR-0034 amendment, decision 16). The base port
 * is a cache with no delete on purpose; uploaded audio is not a cache — it is copyright-sensitive and
 * must be removable the moment its job ends. So deletion and size live on this wider interface, which
 * the three shipped stores implement, rather than on `BlobStore`, whose "nowhere to put invalidation
 * logic" stance (Q81) is unchanged.
 */
export interface ManagedBlobStore extends BlobStore {
  /** The stored size in bytes, or null when nothing is stored under the key. Never reads the body. */
  stat(key: BlobKey): Promise<{ size: number } | null>;
  /** Removes the object. Removing what is not there is not an error. */
  delete(key: BlobKey): Promise<void>;
}

export interface PresignOptions {
  /** How long the URL stays valid, seconds. */
  expiresInSeconds: number;
  /** For a PUT: signed into the URL, so the upload must send exactly this `Content-Type`. */
  contentType?: string;
}

/** A URL a client can use directly, plus the headers it must send with it. */
export interface PresignedRequest {
  url: string;
  method: 'PUT' | 'GET';
  headers: Record<string, string>;
  /** When it stops working, epoch milliseconds. */
  expiresAt: number;
}

/**
 * A store the *client* can talk to directly (ADR-0034 amendment, decision 15): object storage. Bytes
 * then move browser-to-bucket and worker-to-bucket and never cross the API. The directory and memory
 * stores do not implement this, and local mode keeps proxying through the API exactly as before; a
 * caller asks `isPresigning(store)` and falls back.
 */
export interface PresigningBlobStore extends ManagedBlobStore {
  presignPut(key: BlobKey, options: PresignOptions): PresignedRequest;
  presignGet(key: BlobKey, options: PresignOptions): PresignedRequest;
}

export function isPresigning(store: BlobStore): store is PresigningBlobStore {
  return typeof (store as Partial<PresigningBlobStore>).presignPut === 'function';
}
