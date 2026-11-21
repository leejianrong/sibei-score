import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/stack.js';

/**
 * SIB2-178 end to end: title, composer and style are edited from the rail as one `meta.set`, the CLI
 * reads them back, and one ctrl-Z reverts the edit. This closes the last `meta.set` Q79 exception.
 */

interface Doc {
  score: { meta: { title: string; composer: string; style: string | null } };
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
  return page;
}

describe('the title block, over a live stack (SIB2-178)', () => {
  it('sets title, composer and style from the rail; the CLI reads them; undo reverts', async () => {
    const id = 'e2e-title-block';
    stack.cli(['new', '--id', id, '--title', 'Before', '--bars', '4']);
    const page = await openScore(id);
    try {
      await page.getByLabel('Title', { exact: true }).fill('After');
      await page.getByLabel('Composer').fill('A. Writer');
      await page.getByLabel('Style or tempo').fill('Medium swing');
      await page.getByRole('button', { name: 'Set title block' }).click();

      await expect
        .poll(() => (stack.cli(['open', id]) as Doc).score.meta.title)
        .toBe('After');
      const meta = (stack.cli(['open', id]) as Doc).score.meta;
      expect(meta).toMatchObject({ title: 'After', composer: 'A. Writer', style: 'Medium swing' });
      await expect.poll(() => page.locator('.rail-title').textContent()).toContain('After');

      // One edit, one undo.
      await page.keyboard.press('Control+z');
      await expect
        .poll(() => (stack.cli(['open', id]) as Doc).score.meta.title)
        .toBe('Before');
      expect((stack.cli(['open', id]) as Doc).score.meta.style).toBeNull();
    } finally {
      await page.close();
    }
  });
});
