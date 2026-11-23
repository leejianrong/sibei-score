import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRailPanels } from './support/rail.js';
import { startStack, type Stack } from './support/stack.js';

/**
 * SIB2-287 and SIB2-286: the page setup panel and the instrument-names checkbox are the browser halves of
 * `sbscore page set` and `meta set --instrument-names`: the CLI reads back what the browser sets, the verb shows in the
 * browser, and one ctrl-Z reverts a change (Q79).
 */

interface Doc {
  score: { meta: { page?: { staffSize?: number; margin?: { left?: number } }; showInstrumentNames?: boolean } };
}

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 90_000);

afterAll(async () => {
  await stack?.stop();
});

async function openScore(id: string): Promise<Page> {
  const page = await stack.browser.newPage();
  await page.goto(stack.scoreUrl(id), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sheet');
  await openRailPanels(page);
  return page;
}

describe('page setup over a live stack', () => {
  it('sets the staff size and a margin from the rail; the CLI reads them back and undo reverts', async () => {
    const id = 'e2e-page';
    stack.cli(['new', '--id', id, '--title', 'Page', '--bars', '8']);
    const page = await openScore(id);
    try {
      const size = page.getByLabel('Staff size (mm)');
      await size.fill('7');
      await size.press('Enter');
      await expect.poll(() => (stack.cli(['open', id]) as Doc).score.meta.page?.staffSize).toBe(7);

      const left = page.getByLabel('Left margin (mm)');
      await left.fill('22.5');
      await left.press('Enter');
      await expect.poll(() => (stack.cli(['open', id]) as Doc).score.meta.page?.margin?.left).toBe(22.5);

      await page.keyboard.press('Control+z');
      await expect.poll(() => (stack.cli(['open', id]) as Doc).score.meta.page?.margin?.left).toBeUndefined();

      // The verb sets a field for the browser to show.
      stack.cli(['page', 'set', id, '--staff-size', '6']);
      await expect.poll(() => size.inputValue()).toBe('6');
    } finally {
      await page.close();
    }
  });

  it('prints instrument names from the rail checkbox, and the CLI reads it back', async () => {
    const id = 'e2e-names';
    stack.cli(['new', '--id', id, '--title', 'Names', '--bars', '4', '--instrument', 'piano', '--instrument', 'bass']);
    stack.cli(['meta', 'set', id, '--instrument-names', 'off']);
    const page = await openScore(id);
    try {
      expect(await page.locator('text.se-instrument-name').count()).toBe(0);
      await page.getByLabel('Print instrument names').check();
      await expect.poll(() => (stack.cli(['open', id]) as Doc).score.meta.showInstrumentNames).toBe(true);
      await page.locator('text.se-instrument-name').first().waitFor();
    } finally {
      await page.close();
    }
  });
});
