import { afterEach, expect, it } from 'vitest';
import { DEFAULT_LIMITS, createApi, createLimits, memoryBlobLedger, memoryBlobStore, silentLogger } from '@sibei/api';
import type { Api } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';

/** SEC M6: every export parameter combination is its own cache entry; a user may hold only so many. */

let api: Api | undefined;
afterEach(async () => {
  await api?.close();
});

it('evicts the oldest cached exports past the per-user bound', async () => {
  const ledger = memoryBlobLedger();
  const blobs = memoryBlobStore();
  const limits = createLimits({
    config: {
      ...DEFAULT_LIMITS,
      rates: { ...DEFAULT_LIMITS.rates, export: { limit: 1000, windowMs: 60_000 } },
      quotas: { ...DEFAULT_LIMITS.quotas, maxExportCacheEntries: 2 },
    },
  });
  api = createApi({ store: openSqliteStore({ filename: ':memory:' }), blobs, blobLedger: ledger, limits, logger: silentLogger });
  const base = `http://127.0.0.1:${(await api.listen(0)).port}`;
  await fetch(`${base}/v1/scores`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation: { type: 'score.create', payload: { id: 'c', barCount: 4 } } }),
  });
  for (const query of ['format=musicxml', 'format=pdf', 'format=pdf&paper=letter', 'format=pdf&paper=a4']) {
    expect((await fetch(`${base}/v1/scores/c/export?${query}`)).status).toBe(200);
  }
  const held = (await ledger.list('local')).filter((ref) => ref.kind === 'export');
  expect(held).toHaveLength(2);
  for (const ref of held) expect(await blobs.stat(ref.key)).not.toBeNull();
});
