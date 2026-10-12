import { describe, expect, it } from 'vitest';
import * as fixtures from '@sibei/fixtures';
import { FIXTURE_REGISTRY } from '@sibei/fixtures';

/**
 * KAN-593. The render and proof scripts share one registry. This holds the registry to the package:
 * a zero-argument `*Chart` export that is not listed is a fixture `pnpm render` and `pnpm proof` will
 * never see, and nothing else would say so.
 */

describe('the fixture registry', () => {
  const exported = Object.entries(fixtures)
    .filter(([name, value]) => /Chart$/.test(name) && typeof value === 'function' && value.length === 0)
    .map(([, value]) => value as () => unknown);

  it('finds the fixtures it should (a guard over nothing proves nothing)', () => {
    expect(exported.length).toBeGreaterThanOrEqual(8);
  });

  it('lists every zero-argument chart the package exports', () => {
    const listed = new Set<unknown>(Object.values(FIXTURE_REGISTRY));
    const missing = exported.filter((build) => !listed.has(build)).map((build) => build.name);
    expect(missing).toEqual([]);
  });

  it('lists nothing twice under two names', () => {
    const builders = Object.values(FIXTURE_REGISTRY);
    expect(new Set(builders).size).toBe(builders.length);
  });
});
