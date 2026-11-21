import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Account deletion (V25, ADR-0034 decision 11) must reach every table that holds an account's data. A table
 * added later with an `owner` or `user_id` column is exactly how deletion silently stops being complete, so
 * the schemas are read for such tables and each must be named here, with how deletion covers it. Adding a
 * table fails this test until somebody decides (the same device as `exit-code-kinds.test.ts`).
 */

const REPO = resolve(import.meta.dirname, '../..');

/** table -> how `DELETE /v1/auth/account` reaches it. */
const COVERED: Record<string, string> = {
  scores: 'ScoreLibrary.deleteAll',
  operations: 'cascade from scores',
  import_jobs: 'JobStore.deleteAll',
  blob_refs: 'BlobLedger.forgetAll, after the blobs it names are deleted',
  identities: 'cascade from users (AuthStore.deleteUser)',
  sessions: 'cascade from users',
  device_codes: 'cascade from users',
  api_tokens: 'cascade from users',
  oauth_codes: 'cascade from users',
};

function tablesWithAnAccountColumn(file: string): string[] {
  const text = readFileSync(join(REPO, file), 'utf8');
  const found: string[] = [];
  for (const match of text.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
    if (/^\s*(owner|user_id)\s/m.test(match[2]!)) found.push(match[1]!);
  }
  return found;
}

describe('account deletion covers every table that holds an account’s data', () => {
  for (const file of ['packages/api/src/store/sqlite-schema.ts', 'packages/api/src/store/postgres-schema.ts']) {
    it(`${file}`, () => {
      const tables = tablesWithAnAccountColumn(file);
      expect(tables.length).toBeGreaterThan(5); // a guard that finds nothing proves nothing
      expect(tables.filter((table) => COVERED[table] === undefined)).toEqual([]);
    });
  }
});
