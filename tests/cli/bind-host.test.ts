import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFlags, resolveBindHost } from '@sibei/cli';

/**
 * How `sbscore serve` chooses its bind address (V8h). The default is `undefined`, which the API
 * reads as its loopback default (ADR-0029), so a bare `serve` binds `127.0.0.1` exactly as before;
 * `--host` and `SBSCORE_HOST` override it, and the container sets `0.0.0.0`.
 */

const flagsFor = (...argv: string[]) => parseFlags(argv);
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.SBSCORE_HOST;
  delete process.env.SBSCORE_HOST;
});

afterEach(() => {
  if (saved === undefined) delete process.env.SBSCORE_HOST;
  else process.env.SBSCORE_HOST = saved;
});

it('is undefined by default, so the API keeps its loopback bind', () => {
  expect(resolveBindHost(flagsFor())).toBeUndefined();
});

it('reads --host', () => {
  expect(resolveBindHost(flagsFor('--host', '0.0.0.0'))).toBe('0.0.0.0');
});

it('reads SBSCORE_HOST', () => {
  process.env.SBSCORE_HOST = '0.0.0.0';
  expect(resolveBindHost(flagsFor())).toBe('0.0.0.0');
});

it('lets --host win over SBSCORE_HOST', () => {
  process.env.SBSCORE_HOST = '10.0.0.5';
  expect(resolveBindHost(flagsFor('--host', '127.0.0.1'))).toBe('127.0.0.1');
});
