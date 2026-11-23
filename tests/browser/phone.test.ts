import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Score } from '@sibei/model';
import { barTarget } from './support/geometry.js';
import { startStack, type Stack } from './support/stack.js';

/**
 * SIB2-267: on a phone the sheet comes first. The rail is a bottom drawer: shut it shows only its handle, selecting
 * something opens it with the inspector in view, and the controls are finger-sized.
 */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 90_000);

afterAll(async () => {
  await stack?.stop();
});

describe('the score view at 390x844 (SIB2-267)', () => {
  it('shows the sheet on load, opens the inspector on selection, and sizes taps for a finger', async () => {
    const id = 'phone-chart';
    stack.cli(['new', '--id', id, '--title', 'Phone', '--key', 'C', '--bars', '16']);
    const { score } = stack.cli(['open', id]) as { score: Score };
    const page = await stack.browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    try {
      await page.goto(stack.scoreUrl(id), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sheet');

      // The first page is on screen without scrolling.
      const sheet = page.locator('.sheet').first();
      const top = (await sheet.boundingBox())!;
      expect(top.y).toBeLessThan(300);
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(2400);

      // The drawer is shut: its handle is a finger-sized button and its contents are not reachable.
      const handle = page.getByRole('button', { name: 'Controls' });
      const handleBox = (await handle.boundingBox())!;
      expect(handleBox.height).toBeGreaterThanOrEqual(40);
      expect(await handle.getAttribute('aria-expanded')).toBe('false');
      expect(await page.getByTestId('selected-pane').isVisible()).toBe(false);

      // Selecting a bar opens the drawer with its first control inside the viewport.
      const bar = barTarget(score, 2);
      const box = (await sheet.boundingBox())!;
      await sheet.click({ position: { x: bar.cx * box.width, y: bar.cy * box.height } });
      await page.getByLabel('Rehearsal letter').waitFor();
      expect(await handle.getAttribute('aria-expanded')).toBe('true');
      const letter = (await page.getByLabel('Rehearsal letter').boundingBox())!;
      expect(letter.y).toBeGreaterThan(0);
      expect(letter.y + letter.height).toBeLessThanOrEqual(844);
      expect(letter.height).toBeGreaterThanOrEqual(40);
    } finally {
      await page.close();
    }
  });
});
