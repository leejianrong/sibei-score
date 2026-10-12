import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXIT, USAGE_KINDS, USAGE_KIND_PREFIXES, exitCodeForKind } from '@sibei/cli';

/**
 * KAN-612. `exitCodeForKind` takes a string and falls through to 1, so a failure kind added on the
 * server would silently become a usage error on the CLI. The server's kinds are free strings, so the
 * set is read out of its own source rather than restated here — a list restated in a test is the
 * thing that goes stale. Two places name a kind: `problem(status, 'kind', …)` calls, and the
 * `OperationFailure` union in `ops/errors.ts`.
 */

const API_SRC = join(__dirname, '../../packages/api/src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') ? [readFileSync(path, 'utf8')] : [];
  });
}

function serverKinds(): string[] {
  const kinds = new Set<string>();
  for (const text of sources(API_SRC)) {
    for (const m of text.matchAll(/problem\(\s*[A-Za-z0-9_.]+,\s*'([a-z-]+)'/g)) kinds.add(m[1]!);
  }
  const failures = readFileSync(join(API_SRC, 'ops/errors.ts'), 'utf8');
  for (const m of failures.matchAll(/\|\s*\{\s*kind:\s*'([a-z-]+)'/g)) kinds.add(m[1]!);
  return [...kinds].sort();
}

describe('every kind the server can send has an exit code decided', () => {
  const kinds = serverKinds();

  it('finds the kinds it should (a guard that reads nothing proves nothing)', () => {
    expect(kinds).toEqual(
      expect.arrayContaining(['validation', 'stale-version', 'no-such-score', 'foreign-origin']),
    );
    expect(kinds.length).toBeGreaterThan(15);
  });

  it.each(serverKinds())('%s is mapped, or named as deliberately usage', (kind) => {
    const code = exitCodeForKind(kind);
    const named = USAGE_KINDS.includes(kind) || USAGE_KIND_PREFIXES.some((p) => kind.startsWith(p));
    expect(code !== EXIT.usage || named).toBe(true);
  });

  it('does not keep a usage entry for a kind the server no longer sends', () => {
    for (const kind of USAGE_KINDS) expect(kinds).toContain(kind);
  });
});
