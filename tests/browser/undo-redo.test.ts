import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/stack.js';

/**
 * V8a's demo, as an end-to-end test over the whole stack (SLICES.md V8): an agent makes a batch of
 * eight edits, a reader presses ctrl-Z once in the browser, and all eight revert together — because
 * a batch is one undoable unit (ADR-0008). Then ctrl-shift-Z brings them back. It boots the real
 * pieces and drives a real browser for the same reason the V4d tests do: the thing under test is the
 * keybinding reaching the one write path both surfaces share, which a jsdom simulation would fake.
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

/** Count the quarter-note C5s the text projection prints, which is how many of the eight survive. */
function noteCount(id: string): number {
  const shown = stack.cli(['show', id]) as { projection: string };
  return (shown.projection.toLowerCase().match(/c5\/4/g) ?? []).length;
}

/** Author a chart and apply eight note-adds as one batch — an agent's single transactional edit. */
function authorEightInOneBatch(id: string): void {
  stack.cli(['new', '--id', id, '--title', 'Undo', '--key', 'C', '--bars', '4']);
  const eight = Array.from({ length: 8 }, (_, i) => ({
    type: 'note.add',
    target: `bar${i < 4 ? 1 : 2}.beat${(i % 4) + 1}`,
    payload: { pitch: 'C5', duration: { value: 4, dots: 0 } },
  }));
  stack.cli(['batch', id, '--ops', JSON.stringify(eight)]);
}

describe('undo and redo in the browser (V8a)', () => {
  it('reverts a batch of eight edits with one ctrl-Z, and ctrl-shift-Z brings them back', async () => {
    const id = 'e2e-undo';
    authorEightInOneBatch(id);
    expect(noteCount(id)).toBe(8);

    const page = await openScore(id);
    try {
      // create → v1, the batch → v2. The open view is at v2.
      await expect.poll(() => railVersion(page)).toBe('v2');

      // One press. The batch is one undoable unit, so all eight go together.
      await page.keyboard.press('Control+z');
      await expect.poll(() => railVersion(page)).toBe('v3');
      expect(noteCount(id)).toBe(0);

      // Redo puts the whole batch back, and the document is the one from before the undo.
      await page.keyboard.press('Control+Shift+z');
      await expect.poll(() => railVersion(page)).toBe('v4');
      expect(noteCount(id)).toBe(8);
    } finally {
      await page.close();
    }
  });

  it('does nothing on ctrl-Z at the undo floor, and does not error', async () => {
    const id = 'e2e-undo-floor';
    stack.cli(['new', '--id', id, '--title', 'Floor', '--key', 'C', '--bars', '4']);
    const page = await openScore(id);
    try {
      await expect.poll(() => railVersion(page)).toBe('v1');
      await page.keyboard.press('Control+z');
      // Give a would-be write time to land, then confirm nothing did: still v1, still a live sheet.
      await page.waitForTimeout(300);
      expect(await railVersion(page)).toBe('v1');
      expect(await page.locator('.sheet').count()).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });
});
