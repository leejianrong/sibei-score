import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/stack.js';

/**
 * SIB2-264: the rail's document-level panels are collapsible. A fresh load shows the primary ones open (Export,
 * Part, Staves) and the setup ones collapsed; a person's choice survives a reload.
 */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 90_000);

afterAll(async () => {
  await stack?.stop();
});

describe('collapsible rail panels (SIB2-264)', () => {
  it('starts with setup panels collapsed, Export reachable, and remembers a toggle across a reload', async () => {
    const id = 'rail-panels';
    stack.cli(['new', '--id', id, '--title', 'Panels', '--key', 'C', '--bars', '8']);
    const page = await stack.browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(stack.scoreUrl(id), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sheet');

      const open = (name: string) => page.locator(`details.rail-panel[data-panel="${name}"]`).evaluate((el) => (el as HTMLDetailsElement).open);
      expect(await open('Title block')).toBe(false);
      expect(await open('Transpose')).toBe(false);
      expect(await open('Export')).toBe(true);

      // The Export link is reachable with at most one scroll of the rail, not four screens down.
      const link = page.locator('a.export');
      await link.scrollIntoViewIfNeeded();
      const box = await link.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(900);

      await page.locator('details.rail-panel[data-panel="Title block"] > summary').click();
      expect(await open('Title block')).toBe(true);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sheet');
      expect(await open('Title block')).toBe(true);
      expect(await open('Transpose')).toBe(false);
    } finally {
      await page.close();
    }
  });
});
