import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SIB2-205. The API Dockerfile does `COPY . .` from the repo root, and the hosted runbook has the operator
 * put `.env` (the GitHub client secret, DB/Redis passwords) and `backups/` (full database dumps) in that
 * same directory. If `.dockerignore` forgets either, every `up -d --build` bakes them into an image layer.
 * `scripts/smoke-hosted.sh` checks the built image; this is the fast guard on the list itself.
 */
const ROOT = join(__dirname, '../..');
const lines = (file: string): string[] =>
  readFileSync(join(ROOT, file), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

describe('.dockerignore', () => {
  const root = lines('.dockerignore');
  it.each(['.env', '.env.*', 'backups/', 'tools/runpod/', 'deploy/', '*.sql.gz'])(
    'excludes %s from the API image context',
    (p) => {
      expect(root).toContain(p);
    },
  );
  it('has no negation that could re-admit a secret', () => {
    expect(root.filter((l) => l.startsWith('!'))).toEqual([]);
  });
  it('keeps .env out of the worker image context too', () => {
    expect(lines('worker/.dockerignore')).toContain('.env');
  });
});
