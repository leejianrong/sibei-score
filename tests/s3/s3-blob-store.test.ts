import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { openS3BlobStore } from '@sibei/api';
import type { S3BlobStore, S3BlobStoreOptions } from '@sibei/api';
import { blobContract } from '../integration/blob-contract.js';

/**
 * The S3 adapter against a real S3-compatible server (SIB2-136). Opt-in: `pnpm test:s3` starts a
 * throwaway MinIO; the `s3` project in `vitest.config.ts` matches no file without
 * `SBSCORE_TEST_S3_ENDPOINT`. A missing variable is an error here, never a skip — a suite that quietly
 * runs nothing reports green and protects nothing.
 */

function config(): S3BlobStoreOptions {
  const endpoint = process.env.SBSCORE_TEST_S3_ENDPOINT;
  const accessKeyId = process.env.SBSCORE_TEST_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SBSCORE_TEST_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('the s3 tests need SBSCORE_TEST_S3_ENDPOINT, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY (pnpm test:s3)');
  }
  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    region: 'us-east-1',
    bucket: `sibei-test-${randomBytes(4).toString('hex')}`,
  };
}

const base = config();
// Each contract case gets its own prefix in one bucket, so cases cannot see one another's keys.
let counter = 0;
function open(): S3BlobStore {
  counter += 1;
  return openS3BlobStore({ ...base, prefix: `case-${counter}/` });
}

beforeAll(async () => {
  await openS3BlobStore(base).ensureBucket();
});

blobContract('an S3-compatible bucket', open);

describe('presigned transfer (decision 15)', () => {
  it('lands an upload without the bytes crossing the store object', async () => {
    const blobs = open();
    const put = blobs.presignPut('audio:u1:j1', { expiresInSeconds: 60, contentType: 'audio/wav' });
    // The client talks to the bucket directly: plain fetch, no adapter involved.
    const sent = await fetch(put.url, { method: put.method, headers: put.headers, body: new Uint8Array([1, 2, 3, 4]) });
    expect(sent.status).toBe(200);
    expect(await blobs.stat('audio:u1:j1')).toEqual({ size: 4 });

    const get = blobs.presignGet('audio:u1:j1', { expiresInSeconds: 60 });
    const fetched = await fetch(get.url);
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
  });

  it('refuses an upload that sends a different content type than was signed', async () => {
    const blobs = open();
    const put = blobs.presignPut('audio:u1:j2', { expiresInSeconds: 60, contentType: 'audio/wav' });
    const sent = await fetch(put.url, { method: 'PUT', headers: { 'Content-Type': 'text/html' }, body: 'x' });
    expect(sent.status).toBe(403);
    expect(await blobs.stat('audio:u1:j2')).toBeNull();
  });

  it('refuses a URL that has been tampered with, or that is used for the wrong verb', async () => {
    const blobs = open();
    await blobs.put('k', Buffer.from('secret'));
    const get = blobs.presignGet('k', { expiresInSeconds: 60 });
    expect((await fetch(get.url.replace(/X-Amz-Signature=./, 'X-Amz-Signature=0'))).status).toBe(403);
    expect((await fetch(get.url, { method: 'DELETE' })).status).toBe(403);
    expect(await blobs.stat('k')).toEqual({ size: 6 });
  });

  it('refuses an expired URL', async () => {
    const past = openS3BlobStore({ ...base, prefix: 'expired/', now: () => new Date(Date.now() - 3_600_000) });
    await openS3BlobStore({ ...base, prefix: 'expired/' }).put('k', Buffer.from('x'));
    const get = past.presignGet('k', { expiresInSeconds: 60 });
    expect((await fetch(get.url)).status).toBe(403);
  });
});
