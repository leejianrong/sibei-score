import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openSqliteStore } from '@sibei/api/sqlite';
import vitestConfig from '../../vitest.config.js';
import { NATIVE_BINDING_REFUSED, isTheTestRunnersOwn, packageOf } from '../no-native-bindings.js';

/**
 * The `fast` layer needs nothing installed, and that is now a measured property (KAN-514).
 *
 * `suite-layers.test.ts` guards the layers from above — every test directory belongs to one. This
 * guards the one below it: that the layer defined as infra-free actually is. The two failures are
 * the same shape. A directory in neither layer never runs while the summary says green; a layer
 * that quietly needs a compiled module keeps passing on every machine that has one, and fails on
 * the machine that cannot fix it — which, since the pre-push hook runs this layer, is the machine
 * trying to push.
 *
 * Three legs, deliberately independent, because each covers the way the other two could go
 * vacuous:
 *
 *  1. The config wires the trap into `fast` and not into `infra`, read out of the config itself.
 *     Without this, importing the trap here would install it and the second leg would prove
 *     nothing about the rest of the layer.
 *  2. The trap is live, shown against the real driver rather than a synthetic `.node` — a guard
 *     tried only against a stand-in is a guard you are guessing about.
 *  3. `@sibei/api` loads clean, which is the thing the split was for and holds whether or not a
 *     trap exists.
 */

const REPO = resolve(import.meta.dirname, '../..');

function setupFilesOf(name: string): string[] {
  const config = vitestConfig as {
    test?: { projects?: { test?: { name?: string; setupFiles?: string[] } }[] };
  };
  const project = (config.test?.projects ?? []).find((each) => each.test?.name === name);
  expect(project, `no project named ${name}`).toBeDefined();
  return project?.test?.setupFiles ?? [];
}

describe('the fast layer loads no native binding (KAN-514)', () => {
  it('runs the trap before every one of its test files', () => {
    const setup = setupFilesOf('fast');
    expect(setup).toEqual(['tests/no-native-bindings.ts']);
    // Guards the guard: a rename would leave a config pointing at nothing, and vitest is happy
    // to run a project whose setup file does not resolve to anything it can find.
    for (const file of setup) expect(statSync(resolve(REPO, file)).isFile()).toBe(true);
  });

  it('leaves the infra layer alone, because loading the binding is what infra is for', () => {
    expect(setupFilesOf('infra')).toEqual([]);
  });

  it('refuses the real driver at the moment it reaches for its binding', () => {
    // better-sqlite3 loads its `.node` lazily — on `new Database(...)`, not on import — which is
    // the only reason the pre-split fast layer got away with importing it at all. So the trap has
    // to be exercised where the load actually happens, and this is that place.
    let refusal: unknown;
    try {
      openSqliteStore({ filename: ':memory:' });
    } catch (error) {
      refusal = error;
    }
    expect(refusal, 'the fast layer opened a SQLite store').toBeInstanceOf(Error);
    expect((refusal as { code?: string }).code).toBe(NATIVE_BINDING_REFUSED);
    // The report names the binding, because "something native loaded" is not actionable.
    expect((refusal as Error).message).toMatch(/\.node\b/);
  });

  it('lets a pure test import @sibei/api without any of that', () => {
    // The property the split exists for, and the reason the three fast-layer tests that import
    // the package are allowed to stay where they belong. If the barrel ever re-exports the
    // adapter again this rejects, under the trap the first assertion proved is live.
    return expect(import('@sibei/api')).resolves.toBeDefined();
  });

  it('exempts the runner by package, and nothing a product dependency loads', () => {
    // The exemption is what makes the trap survivable at all — vite-node parses in the worker —
    // and it is also the obvious place for it to be widened until it means nothing. So the shape
    // of the match is asserted: it is the owning package, not a substring of the path, and the
    // driver is on the wrong side of it.
    const driver =
      '/repo/node_modules/.pnpm/better-sqlite3@13.0.2/node_modules/better-sqlite3/prebuilds/linux-x64.node';
    const runner =
      '/repo/node_modules/.pnpm/@rollup+rollup-linux-x64-gnu@4.62.3/node_modules/@rollup/rollup-linux-x64-gnu/rollup.linux-x64-gnu.node';
    expect(packageOf(driver)).toBe('better-sqlite3');
    expect(packageOf(runner)).toBe('@rollup/rollup-linux-x64-gnu');
    expect(isTheTestRunnersOwn(driver)).toBe(false);
    expect(isTheTestRunnersOwn(runner)).toBe(true);
  });

  it('keeps the adapter off the barrel, so the split survives the trap being removed', async () => {
    // Structural rather than behavioural: ADR-0006's port is the package's surface and the one
    // implementation of it is an opt-in entry point. Asserted separately so that deleting the
    // trap would cost a red test rather than silently re-opening the door.
    const barrel = (await import('@sibei/api')) as Record<string, unknown>;
    expect(barrel).not.toHaveProperty('openSqliteStore');
    expect(Object.keys(barrel).filter((name) => /sqlite/i.test(name))).toEqual([]);
  });
});
