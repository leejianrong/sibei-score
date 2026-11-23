import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/stack.js';

/**
 * SIB2-266: with a chart open and the server unreachable, the app says so. The top-bar dot goes down, a sticky
 * banner names the lost connection, a write that gets no answer says it was not saved and offers Retry, and the
 * banner clears when the connection returns. The outage is real: the harness kills the API process and later starts it again on the same port.
 */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 90_000);

afterAll(async () => {
  await stack?.stop();
});

describe('offline state and failed writes (SIB2-266)', () => {
  it('shows the lost connection, reports a failed write with Retry, and recovers', async () => {
    const id = 'offline-chart';
    stack.cli(['new', '--id', id, '--title', 'Offline', '--key', 'C', '--bars', '4']);
    const context = await stack.browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      await page.goto(stack.scoreUrl(id), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sheet');
      await expect.poll(() => page.locator('.dot.down').count()).toBe(0);

      await stack.stopApi();
      await expect.poll(() => page.locator('.dot.down').count(), { timeout: 15_000 }).toBe(1);
      const lost = page.getByRole('alert').filter({ hasText: 'Connection lost' });
      await expect.poll(() => lost.isVisible()).toBe(true);

      // A write with no answer: visible, named, and offered again.
      await page.getByRole('button', { name: 'Add a bar at the end' }).click();
      const failed = page.getByRole('alert').filter({ hasText: 'not saved' });
      await expect.poll(() => failed.isVisible()).toBe(true);
      expect(await failed.getByRole('button', { name: 'Retry' }).isVisible()).toBe(true);

      await stack.startApi();
      await expect.poll(() => page.locator('.dot.down').count(), { timeout: 20_000 }).toBe(0);
      await expect.poll(() => lost.count()).toBe(0);

      await failed.getByRole('button', { name: 'Retry' }).click();
      await expect.poll(() => failed.count()).toBe(0);
      const opened = stack.cli(['open', id]) as { score: { bars: unknown[] } };
      expect(opened.score.bars).toHaveLength(5);
    } finally {
      await context.close();
    }
  });
});
