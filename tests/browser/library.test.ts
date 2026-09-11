import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/stack.js';

/**
 * V8c's library actions over the whole stack: delete (which asks first, because it destroys the op
 * log) and duplicate (a copy with a fresh history). A real browser, because the thing under test is
 * the row's controls reaching the one API both surfaces share — the CLI reads back what the browser
 * did, which is the "cannot disagree" property in the one view that had no writes before this slice.
 */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 90_000);

afterAll(async () => {
  await stack?.stop();
});

async function openLibrary(): Promise<Page> {
  const page = await stack.browser.newPage();
  await page.goto(`${stack.uiUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.row');
  return page;
}

function rowCount(page: Page): Promise<number> {
  return page.locator('.row').count();
}

describe('the library delete and duplicate over a live stack (V8c)', () => {
  it('duplicates a chart: a new row appears, marked, and the CLI reads it back', async () => {
    stack.cli(['new', '--id', 'aardvark', '--title', 'Aardvark', '--key', 'C', '--bars', '4']);
    stack.cli(['new', '--id', 'zebra', '--title', 'Zebra', '--key', 'G', '--bars', '4']);
    const page = await openLibrary();
    try {
      await expect.poll(() => rowCount(page)).toBe(2);

      const row = page.locator('.row', { hasText: 'Aardvark' });
      await row.hover();
      await row.locator('.act.dup').click();

      // A third row lands, and it is flagged as the fresh copy.
      await expect.poll(() => rowCount(page)).toBe(3);
      await expect.poll(() => page.locator('.fresh-tag').count()).toBe(1);

      // And it is really in the store: the CLI opens the minted copy.
      const opened = stack.cli(['open', 'aardvark-copy']) as { score: { meta: { title: string } } };
      expect(opened.score.meta.title).toBe('Aardvark');
    } finally {
      await page.close();
    }
  });

  it('deletes a chart, but only after the inline confirm', async () => {
    stack.cli(['new', '--id', 'keeper', '--title', 'Keeper', '--key', 'C', '--bars', '4']);
    stack.cli(['new', '--id', 'goner', '--title', 'Goner', '--key', 'G', '--bars', '4']);
    const page = await openLibrary();
    try {
      await expect.poll(() => rowCount(page)).toBeGreaterThanOrEqual(2);
      const before = await rowCount(page);

      const row = page.locator('.row', { hasText: 'Goner' });
      await row.hover();
      await row.locator('.act.del').click();

      // Asking first: the confirm shows, and Cancel backs out without deleting.
      await row.locator('.confirm').waitFor({ timeout: 5_000 });
      await row.locator('.confirm .cancel').click();
      expect(await rowCount(page)).toBe(before);

      // Confirming actually removes it, and the CLI can no longer open it.
      await row.hover();
      await row.locator('.act.del').click();
      await row.locator('.confirm .go').click();
      await expect.poll(() => rowCount(page)).toBe(before - 1);
      expect((stack.cli(['list']) as { scores: { id: string }[] }).scores.some((s) => s.id === 'goner')).toBe(false);
    } finally {
      await page.close();
    }
  });
});
