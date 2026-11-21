import { describe, expect, it } from 'vitest';
import { isPresigning, memoryBlobStore, openS3BlobStore } from '@sibei/api';

/**
 * The S3 adapter's pure half (SIB2-136): presigning needs no network, so its shape is pinned in the fast
 * layer. That the signature is *accepted* by a real server is `tests/s3/` (opt-in, `pnpm test:s3`).
 */
const store = openS3BlobStore({
  endpoint: 'http://s3.internal:9000',
  publicEndpoint: 'https://files.example.com',
  region: 'eu-west-1',
  bucket: 'sibei',
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
  prefix: 'audio/',
  now: () => new Date('2026-12-01T10:00:00.000Z'),
});

describe('S3 presigning', () => {
  it('signs against the public endpoint, path-style, with a hashed object name', () => {
    const put = store.presignPut('audio:u1:j1', { expiresInSeconds: 900, contentType: 'audio/wav' });
    const url = new URL(put.url);
    expect(url.origin).toBe('https://files.example.com');
    expect(url.pathname).toMatch(/^\/sibei\/audio\/[0-9a-f]{64}$/);
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toBe('AKID/20261201/eu-west-1/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261201T100000Z');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(put.headers).toEqual({ 'Content-Type': 'audio/wav' });
    expect(put.expiresAt).toBe(Date.parse('2026-12-01T10:15:00.000Z'));
  });

  it('is deterministic, and a different key or verb gives a different signature', () => {
    const sig = (u: string) => new URL(u).searchParams.get('X-Amz-Signature');
    const a = store.presignGet('k', { expiresInSeconds: 60 }).url;
    expect(store.presignGet('k', { expiresInSeconds: 60 }).url).toBe(a);
    expect(sig(store.presignGet('other', { expiresInSeconds: 60 }).url)).not.toBe(sig(a));
    expect(sig(store.presignPut('k', { expiresInSeconds: 60 }).url)).not.toBe(sig(a));
  });

  it('is what isPresigning recognises, and the memory store is not', () => {
    expect(isPresigning(store)).toBe(true);
    expect(isPresigning(memoryBlobStore())).toBe(false);
  });
});
