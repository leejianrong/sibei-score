import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/stack.js';

/**
 * V14 step 4 end-to-end: the **no-sections advisory** in the score rail, over the live stack.
 *
 * Sections drive line-breaking (ADR-0015), and a fresh import detects none (ADR-0021), so a
 * section-less chart lays out on a plain four-bar grid until the user adds one. The rail surfaces
 * that as a **non-blocking advisory** — a prompt, never a refusal (ADR-0013/0019 never refuse a
 * draft). This drives a real browser because the thing under test is the rail reacting to the model:
 * the advisory shows for a section-less chart and *disappears* the moment a section exists, and the
 * predicate (`reviewSummary(...).hasSections`) is the same one the CLI reads — a jsdom stub would
 * pass while the wiring was wrong.
 */

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

function railVersion(page: Page): Promise<string> {
  return page.locator('dt:text-is("version") + dd').textContent().then((text) => text ?? '');
}

describe('the no-sections advisory in the score rail (V14)', () => {
  it('shows for a section-less chart and disappears once the CLI adds a section', async () => {
    const id = 'e2e-no-sections';
    stack.cli(['new', '--id', id, '--title', 'Advisory', '--key', 'C', '--bars', '4']);
    // A note gives the sheet ink; the advisory is about layout, not about this note.
    stack.cli(['note', 'add', id, 'bar1.beat1', '--pitch', 'C5', '--dur', '4']);

    const page = await openScore(id);
    try {
      await expect.poll(() => railVersion(page)).toBe('v2');

      // A fresh chart has no sections, so the advisory is present and reads as a prompt about layout.
      const advisory = page.locator('.review-advisory');
      await expect.poll(() => advisory.count()).toBe(1);
      expect(await advisory.textContent()).toContain('no sections');

      // Add a section from the other surface. The change stream repaints the open view (V4a).
      stack.cli(['section', 'set', id, 'bar1', '--letter', 'A']);
      await expect.poll(() => railVersion(page)).toBe('v3');

      // With a section on the chart, the advisory is gone — the layout now breaks at the form.
      await expect.poll(() => page.locator('.review-advisory').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
});
