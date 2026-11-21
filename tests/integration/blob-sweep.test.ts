import { describe, expect, it } from 'vitest';
import { createBlobSweeper, memoryBlobLedger, memoryBlobStore } from '@sibei/api';

/** The blob sweep (V25b): expired blobs go, young ones and unswept kinds stay, and the ledger follows the blobs. */
const HOUR = 3_600_000;

describe('the blob sweep', () => {
  it('deletes blobs of a swept kind past their lifetime, keeps the rest, and forgets what it deleted', async () => {
    let clock = Date.parse('2026-12-01T00:00:00Z');
    const now = (): Date => new Date(clock);
    const ledger = memoryBlobLedger(now);
    const blobs = memoryBlobStore();
    const put = async (owner: string, key: string, kind: string): Promise<void> => {
      await blobs.put(key, Buffer.from(key));
      await ledger.record(owner, key, kind);
    };

    await put('alice', 'export-old', 'export');
    await put('alice', 'scan', 'import-source');
    await put('bob', 'audio-old', 'audio');
    clock += 30 * HOUR;
    await put('bob', 'audio-new', 'audio');
    await put('bob', 'export-new', 'export');

    const sweeper = createBlobSweeper({ ledger, blobs, now, lifetimes: { export: 24 * HOUR, audio: 24 * HOUR } });
    expect(await sweeper.sweepOnce()).toEqual({ export: 1, audio: 1 });

    expect(await blobs.get('export-old')).toBeNull();
    expect(await blobs.get('audio-old')).toBeNull();
    // young, and a kind that is never swept (a scan lives as long as its job)
    for (const key of ['audio-new', 'export-new', 'scan']) expect(await blobs.get(key)).not.toBeNull();
    expect((await ledger.list('bob')).map((ref) => ref.key).sort()).toEqual(['audio-new', 'export-new']);
    expect((await ledger.list('alice')).map((ref) => ref.key)).toEqual(['scan']);

    // a second pass finds nothing left to do
    expect(await sweeper.sweepOnce()).toEqual({ export: 0, audio: 0 });
  });

  it('keeps the ledger row when the delete fails, so the next pass retries', async () => {
    let clock = Date.parse('2026-12-01T00:00:00Z');
    const now = (): Date => new Date(clock);
    const ledger = memoryBlobLedger(now);
    let failing = true;
    const blobs = {
      ...memoryBlobStore(),
      async delete() {
        if (failing) throw new Error('bucket unreachable');
      },
    };
    await ledger.record('alice', 'k', 'export');
    clock += 48 * HOUR;
    const sweeper = createBlobSweeper({ ledger, blobs, now, lifetimes: { export: 24 * HOUR } });
    await expect(sweeper.sweepOnce()).rejects.toThrow('bucket unreachable');
    expect(await ledger.list('alice')).toHaveLength(1);
    failing = false;
    expect(await sweeper.sweepOnce()).toEqual({ export: 1 });
    expect(await ledger.list('alice')).toEqual([]);
  });
});
