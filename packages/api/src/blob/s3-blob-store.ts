import { createHash, createHmac } from 'node:crypto';
import type { BlobKey, PresignedRequest, PresignOptions, PresigningBlobStore } from './blob-store.js';

/**
 * The S3-compatible implementation of the blob port (ADR-0034 amendment, decisions 15–16; SIB2-136).
 *
 * It speaks the S3 REST API with AWS Signature V4 over `fetch` and `node:crypto` and nothing else — no
 * SDK, so the server image gains no dependency and the whole adapter is one reviewable file. It targets
 * anything S3-shaped (AWS, Cloudflare R2, MinIO) with **path-style** addressing, which every one of them
 * accepts; a virtual-hosted style is a config knob nobody has asked for.
 *
 * What it adds over the directory store is the thing object storage is *for* here: `presignPut` and
 * `presignGet` return a URL a browser or the audio worker uses against the bucket directly, so audio
 * bytes never cross the API (decision 15). The API itself only ever calls `stat` (is it there, how big)
 * and `delete` (retention, decision 16).
 *
 * **The object name is a hash of the key plus a configured prefix**, as in the directory store, for the
 * same reason: a key may carry whatever the client chose, and a hash is one code path that is safe and
 * bounded in every backend.
 */

export interface S3BlobStoreOptions {
  /** The service URL the API talks to, e.g. `http://minio:9000` or `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  /**
   * The URL *clients* are given in presigned links, when it differs from `endpoint` (the API reaches
   * MinIO on the compose network; a browser reaches it at a public name). The signature covers the host,
   * so it is signed against this one. Defaults to `endpoint`.
   */
  publicEndpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Prepended to every object name, e.g. `audio/`. */
  prefix?: string;
  /** Injected so a test can pin time or a fake service; defaults to the global. */
  fetch?: typeof fetch;
  now?: () => Date;
}

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

/** The adapter, plus the one operation only an operator or a test needs: making the bucket. */
export interface S3BlobStore extends PresigningBlobStore {
  /** Creates the bucket if it is not there. The API never calls this; provisioning does. */
  ensureBucket(): Promise<void>;
}

export function openS3BlobStore(options: S3BlobStoreOptions): S3BlobStore {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const prefix = options.prefix ?? '';
  const base = new URL(options.endpoint);
  const publicBase = new URL(options.publicEndpoint ?? options.endpoint);

  function objectName(key: BlobKey): string {
    return `${prefix}${createHash('sha256').update(key, 'utf8').digest('hex')}`;
  }

  /** `/bucket/name`, under the endpoint's own path, each segment encoded once (S3 does not double-encode). */
  function pathFor(endpoint: URL, key: BlobKey): string {
    const root = endpoint.pathname.replace(/\/+$/, '');
    return `${root}/${encode(options.bucket)}/${objectName(key).split('/').map(encode).join('/')}`;
  }

  function objectPath(key: BlobKey): string {
    return pathFor(base, key);
  }

  function scope(date: string): string {
    return `${date}/${options.region}/s3/aws4_request`;
  }

  function signingKey(date: string): Buffer {
    const k1 = hmac(`AWS4${options.secretAccessKey}`, date);
    const k2 = hmac(k1, options.region);
    const k3 = hmac(k2, 's3');
    return hmac(k3, 'aws4_request');
  }

  function signature(date: string, stamp: string, canonicalRequest: string): string {
    const toSign = ['AWS4-HMAC-SHA256', stamp, scope(date), sha256(canonicalRequest)].join('\n');
    return createHmac('sha256', signingKey(date)).update(toSign).digest('hex');
  }

  function presign(method: 'PUT' | 'GET', key: BlobKey, o: PresignOptions): PresignedRequest {
    const at = now();
    const stamp = amzDate(at);
    const date = stamp.slice(0, 8);
    const headers: Record<string, string> = {};
    const signed: Record<string, string> = { host: publicBase.host };
    if (method === 'PUT' && o.contentType !== undefined) {
      signed['content-type'] = o.contentType;
      headers['Content-Type'] = o.contentType;
    }
    const signedHeaders = Object.keys(signed).sort().join(';');
    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${options.accessKeyId}/${scope(date)}`,
      'X-Amz-Date': stamp,
      'X-Amz-Expires': String(Math.max(1, Math.floor(o.expiresInSeconds))),
      'X-Amz-SignedHeaders': signedHeaders,
    };
    const path = pathFor(publicBase, key);
    const canonicalQuery = canonicalQueryOf(query);
    const canonicalRequest = [
      method,
      path,
      canonicalQuery,
      Object.keys(signed)
        .sort()
        .map((name) => `${name}:${signed[name]}\n`)
        .join(''),
      signedHeaders,
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const sig = signature(date, stamp, canonicalRequest);
    return {
      url: `${publicBase.origin}${path}?${canonicalQuery}&X-Amz-Signature=${sig}`,
      method,
      headers,
      expiresAt: at.getTime() + Math.floor(o.expiresInSeconds) * 1000,
    };
  }

  /** A header-signed request, for the calls the API itself makes. */
  async function call(method: 'GET' | 'PUT' | 'HEAD' | 'DELETE', path: string, body?: Buffer): Promise<Response> {
    const at = now();
    const stamp = amzDate(at);
    const date = stamp.slice(0, 8);
    const payloadHash = body === undefined ? EMPTY_SHA256 : createHash('sha256').update(body).digest('hex');
    const signed: Record<string, string> = {
      host: base.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': stamp,
    };
    const signedHeaders = Object.keys(signed).sort().join(';');
    const canonicalRequest = [
      method,
      path,
      '',
      Object.keys(signed)
        .sort()
        .map((name) => `${name}:${signed[name]}\n`)
        .join(''),
      signedHeaders,
      payloadHash,
    ].join('\n');
    const authorization = `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope(date)}, SignedHeaders=${signedHeaders}, Signature=${signature(date, stamp, canonicalRequest)}`;
    return doFetch(`${base.origin}${path}`, {
      method,
      headers: {
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': stamp,
        authorization,
      },
      ...(body === undefined ? {} : { body: new Uint8Array(body) }),
    });
  }

  async function fail(operation: string, response: Response): Promise<never> {
    // The response body can echo request details; the status and S3's error code are enough.
    const text = await response.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? '';
    throw new Error(`blob store ${operation} failed: ${response.status}${code === '' ? '' : ` ${code}`}`);
  }

  return {
    async get(key) {
      const response = await call('GET', objectPath(key));
      if (response.status === 404) {
        await response.arrayBuffer();
        return null;
      }
      if (!response.ok) return fail('get', response);
      return Buffer.from(await response.arrayBuffer());
    },

    async put(key, bytes) {
      const response = await call('PUT', objectPath(key), bytes);
      if (!response.ok) return fail('put', response);
      await response.arrayBuffer();
    },

    async stat(key) {
      const response = await call('HEAD', objectPath(key));
      if (response.status === 404) return null;
      if (!response.ok) return fail('stat', response);
      return { size: Number(response.headers.get('content-length') ?? '0') };
    },

    async delete(key) {
      const response = await call('DELETE', objectPath(key));
      // S3 answers 204 whether or not it was there; a 404 from a stricter backend is the same outcome.
      if (!response.ok && response.status !== 404) return fail('delete', response);
      await response.arrayBuffer();
    },

    async ensureBucket() {
      const response = await call('PUT', `${base.pathname.replace(/\/+$/, '')}/${encode(options.bucket)}`);
      // 409 BucketAlreadyOwnedByYou is the idempotent case on every S3-shaped service.
      if (!response.ok && response.status !== 409) return fail('ensureBucket', response);
      await response.arrayBuffer();
    },

    presignPut: (key, o) => presign('PUT', key, o),
    presignGet: (key, o) => presign('GET', key, o),
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** `20240101T000000Z`. */
function amzDate(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** RFC 3986 unreserved characters pass; everything else is %XX, which is what SigV4 canonicalises to. */
function encode(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQueryOf(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((name) => `${encode(name)}=${encode(query[name] as string)}`)
    .join('&');
}
