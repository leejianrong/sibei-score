import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/stack.js';

/**
 * ADR-0041 slice 5a: `meta.layout` has a verb (`meta set --layout`) and a Layout select in the rail, the same
 * `meta.set` op, so the CLI reads back what the browser sets and one ctrl-Z reverts it (Q79).
 */

interface Doc {
  score: { meta: { layout?: string } };
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

describe('the layout select, over a live stack (ADR-0041 slice 5a)', () => {
  it('sets the layout from the rail, the CLI reads it back, and undo reverts it', async () => {
    const id = 'e2e-layout';
    stack.cli(['new', '--id', id, '--title', 'Layout', '--bars', '8']);
    const page = await openScore(id);
    try {
      await page.getByLabel('How systems are broken').selectOption('score');
      await expect.poll(() => (stack.cli(['open', id]) as Doc).score.meta.layout).toBe('score');

      await page.keyboard.press('Control+z');
      await expect.poll(() => (stack.cli(['open', id]) as Doc).score.meta.layout).toBeUndefined();

      // And the verb sets it for the browser to show.
      stack.cli(['meta', 'set', id, '--layout', 'score']);
      await expect.poll(() => page.getByLabel('How systems are broken').inputValue()).toBe('score');
    } finally {
      await page.close();
    }
  });
});
