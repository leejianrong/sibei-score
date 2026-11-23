import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/stack.js';

/** SIB2-271: the library sorts (recent or title), remembers it, and keeps the terminal hint for the empty state. */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 90_000);

afterAll(async () => {
  await stack?.stop();
});

describe('library sort and hint (SIB2-271)', () => {
  it('sorts by recent or title, remembers the choice, and drops the terminal hint', async () => {
    stack.cli(['new', '--id', 'aardvark', '--title', 'Aardvark', '--bars', '4']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    stack.cli(['new', '--id', 'zebra', '--title', 'Zebra', '--bars', '4']);
    const page = await stack.browser.newPage();
    try {
      await page.goto(`${stack.uiUrl}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.row');
      const names = (): Promise<string[]> => page.locator('.row .row-name > span:first-child').allInnerTexts();
      expect(await names()).toEqual(['Zebra', 'Aardvark']);

      await page.getByLabel('Sort charts').selectOption('title');
      expect(await names()).toEqual(['Aardvark', 'Zebra']);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.row');
      expect(await names()).toEqual(['Aardvark', 'Zebra']);

      // With charts present the library no longer sends the reader to a terminal.
      expect(await page.getByText('author a chart in the terminal').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
});
