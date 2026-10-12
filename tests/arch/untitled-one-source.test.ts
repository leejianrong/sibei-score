import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * KAN-609. The word for a chart nobody has named lives in `packages/model/src/title.ts` and nowhere
 * else, so the browser and `sbscore list` cannot phrase the same fact differently. A literal
 * 'Untitled' in either surface is a second source.
 */

const ROOT = join(__dirname, '../..');
const SURFACES = ['packages/cli/src', 'packages/ui/src'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|svelte)$/.test(path) ? [path] : [];
  });
}

describe('the placeholder for an unnamed chart has one source', () => {
  it.each(SURFACES)('%s names it only through @sibei/model', (surface) => {
    const offenders = files(join(ROOT, surface)).filter((path) =>
      /['"`>]Untitled['"`<]/.test(readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('both surfaces do import it (a guard over nothing proves nothing)', () => {
    const uses = SURFACES.flatMap((surface) => files(join(ROOT, surface))).filter((path) =>
      /\b(displayTitle|UNTITLED)\b/.test(readFileSync(path, 'utf8')),
    );
    expect(uses.some((p) => p.includes('packages/cli'))).toBe(true);
    expect(uses.some((p) => p.includes('packages/ui'))).toBe(true);
  });
});
