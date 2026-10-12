import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * One typeface across the account chrome (V21b). The first mockup set the headline in the chart-title
 * serif and the code in a monospace, and it read as three voices on one card. The fix is a token, not a
 * review comment: every type role in `m3.css` takes the one family, and the five account components name no
 * family of their own, so a later change cannot reintroduce a second voice without failing here. The
 * browser test measures the rendered result; this holds the source that produces it.
 */

const UI = join(__dirname, '../../packages/ui/src');
const COMPONENTS = ['SignInGate', 'AccountMenu', 'SessionBanner', 'DeviceApproval', 'TokenList'];
const read = (path: string): string => readFileSync(join(UI, path), 'utf8');

describe('the account chrome has one typeface', () => {
  const tokens = read('m3.css');

  it('gives every type role the one family', () => {
    const roles = [...tokens.matchAll(/(--md-sys-typescale-[a-z-]+):\s*([^;]+);/g)].filter(
      ([, name]) => !name!.endsWith('-tracking'),
    );
    expect(roles.length).toBeGreaterThanOrEqual(8);
    for (const [, name, value] of roles) {
      expect({ role: name, usesTheFamily: value!.includes('var(--md-sys-font)') }).toEqual({
        role: name,
        usesTheFamily: true,
      });
    }
  });

  it('defines that family once, as a sans stack with a generic fallback and no serif or mono in it', () => {
    const defs = [...tokens.matchAll(/--md-sys-font:\s*([^;]+);/g)];
    expect(defs).toHaveLength(1);
    const stack = defs[0]![1]!;
    expect(stack.trim().endsWith('sans-serif')).toBe(true);
    expect(stack).not.toMatch(/mono/i);
    expect(stack.replace(/sans-serif/g, '')).not.toMatch(/serif/i);
  });

  it.each(COMPONENTS)('%s names no font family of its own', (name) => {
    const source = read(`components/${name}.svelte`);
    expect(source).not.toMatch(/font-family/);
    expect(source).not.toMatch(/var\(--(serif|mono)\)/);
    expect(source).not.toMatch(/monospace/);
    // Every `font:` shorthand takes a type role, never a literal.
    for (const [, value] of source.matchAll(/\bfont:\s*([^;]+);/g)) {
      expect(value).toMatch(/var\(--md-sys-typescale-[a-z-]+\)|^inherit$/);
    }
  });
});
