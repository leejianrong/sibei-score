import { describe, expect, it } from 'vitest';
import type { ManagedBlobStore } from '@sibei/api';

/**
 * The blob port's contract (ADR-0006), as a function so every implementation joins one table of
 * assertions: memory and a directory in the fast layer (`blob-store.test.ts`), an S3-compatible bucket
 * in the opt-in `s3` layer (`tests/s3/`, SIB2-136). The contract belongs to the port, not the medium.
 */
export function blobContract(name: string, open: () => ManagedBlobStore): void {
  describe(`the blob port, ${name}`, () => {
    it('gives back what it was given', async () => {
      const blobs = open();
      await blobs.put('k', Buffer.from('%PDF-1.3 ...'));
      expect((await blobs.get('k'))?.toString()).toBe('%PDF-1.3 ...');
    });

    it('answers a miss with null rather than throwing, because a cold cache is ordinary', async () => {
      expect(await open().get('never-written')).toBeNull();
    });

    it('keeps keys apart', async () => {
      const blobs = open();
      await blobs.put('a', Buffer.from('one'));
      await blobs.put('b', Buffer.from('two'));
      expect((await blobs.get('a'))?.toString()).toBe('one');
      expect((await blobs.get('b'))?.toString()).toBe('two');
    });

    it('overwrites a key rather than appending to it', async () => {
      const blobs = open();
      await blobs.put('k', Buffer.from('first'));
      await blobs.put('k', Buffer.from('second'));
      expect((await blobs.get('k'))?.toString()).toBe('second');
    });

    it('round-trips bytes that are not text', async () => {
      const blobs = open();
      const bytes = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13]);
      await blobs.put('k', bytes);
      expect((await blobs.get('k'))?.equals(bytes)).toBe(true);
    });

    it('hands back a copy, so a caller cannot edit the cache through its own buffer', async () => {
      const blobs = open();
      await blobs.put('k', Buffer.from('original'));
      const first = await blobs.get('k');
      first?.write('tampered');
      expect((await blobs.get('k'))?.toString()).toBe('original');
    });

    it('treats a key as a name and not as a path', async () => {
      // A key carries a score id, and a score id is whatever the client chose. This is the case
      // that would be a traversal if the implementation ever joined a key onto a directory.
      const blobs = open();
      await blobs.put('export:../../etc/passwd:v1:concert:pdf', Buffer.from('contained'));
      expect((await blobs.get('export:../../etc/passwd:v1:concert:pdf'))?.toString()).toBe('contained');
    });

    it('reports a stored size without reading the body, and null for a miss', async () => {
      const blobs = open();
      expect(await blobs.stat('absent')).toBeNull();
      await blobs.put('k', Buffer.from('12345'));
      expect(await blobs.stat('k')).toEqual({ size: 5 });
    });

    it('deletes, and deleting what is not there is not an error', async () => {
      const blobs = open();
      await blobs.put('k', Buffer.from('x'));
      await blobs.delete('k');
      expect(await blobs.get('k')).toBeNull();
      expect(await blobs.stat('k')).toBeNull();
      await expect(blobs.delete('k')).resolves.toBeUndefined();
    });
  });
}
