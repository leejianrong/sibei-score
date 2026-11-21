import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Redis seam (V23, ADR-0034 decision 8). The change bus and the rate-limit counters are ports with an
 * in-process default; Redis is an adapter chosen by configuration. That stays true only while exactly one
 * file knows the driver, so it is asserted (the same shape as `store-seam.test.ts`).
 */

const REPO = resolve(import.meta.dirname, '../..');
const THE_REDIS_ADAPTER = 'packages/api/src/redis.ts';

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (entry.endsWith('.ts')) found.push(path);
  }
  return found;
}

const codeOf = (file: string): string =>
  readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the Redis seam (ADR-0034)', () => {
  it('lets one file import the driver', () => {
    const importers = [...sourceFiles(join(REPO, 'packages')), ...sourceFiles(join(REPO, 'scripts'))]
      .filter((file) => /['"]ioredis['"]/.test(codeOf(file)))
      .map((file) => relative(REPO, file));
    expect(importers).toEqual([THE_REDIS_ADAPTER]);
  });

  it('is declared by `@sibei/api` alone, and not at the root', () => {
    const declares = (manifest: string): boolean => {
      const { dependencies, devDependencies } = JSON.parse(readFileSync(manifest, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return Object.keys({ ...dependencies, ...devDependencies }).includes('ioredis');
    };
    const declaring = readdirSync(join(REPO, 'packages')).filter((name) =>
      declares(join(REPO, 'packages', name, 'package.json')),
    );
    expect(declaring).toEqual(['api']);
    expect(declares(join(REPO, 'package.json'))).toBe(false);
  });

  it('keeps the adapter off the package barrel, so importing the API loads no Redis driver', async () => {
    const barrel = (await import('@sibei/api')) as Record<string, unknown>;
    expect(barrel).not.toHaveProperty('openRedis');
  });
});
