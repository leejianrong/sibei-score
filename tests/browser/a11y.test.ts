import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/stack.js';

/**
 * SIB2-269: the sheet to assistive technology. A real browser, because roles, labels, the live region and where focus
 * lands are all things the DOM does, not the components' source.
 */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 90_000);

afterAll(async () => {
  await stack?.stop();
});

describe('the sheet and assistive technology (SIB2-269)', () => {
  it('labels the sheet, carries the text projection, announces selections and edits, and keeps focus', async () => {
    const id = 'e2e-a11y';
    stack.cli(['new', '--id', id, '--title', 'Readable', '--key', 'C', '--bars', '4']);
    stack.cli(['note', 'add', id, 'bar1.beat1', '--pitch', 'C5', '--dur', '4']);
    stack.cli(['note', 'add', id, 'bar1.beat2', '--pitch', 'G4', '--dur', '2']);
    const shown = (stack.cli(['show', id]) as { projection: string }).projection;
    const page = await stack.browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(stack.scoreUrl(id), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sheet');

      // The sheet has a role and a label naming the chart and page, and is described by the text alternative.
      const sheet = page.locator('.sheet').first();
      expect(await sheet.getAttribute('role')).toBe('application');
      expect(await sheet.getAttribute('aria-label')).toBe('Sheet music: Readable, page 1 of 1');
      const describedBy = await sheet.getAttribute('aria-describedby');
      expect(describedBy).toBe('sheet-text');

      // The text alternative is the very projection the CLI's `show` prints.
      const alternative = page.getByTestId('sheet-text');
      expect(await alternative.getAttribute('id')).toBe(describedBy);
      expect(await alternative.textContent()).toBe(shown);
      // ...and is off-screen, not display:none (which would hide it from a screen reader too).
      const box = (await alternative.boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(2);
      expect(await alternative.evaluate((el) => getComputedStyle(el).display)).not.toBe('none');

      // A selection is announced in the live region.
      const status = page.getByTestId('a11y-status');
      expect(await status.getAttribute('role')).toBe('status');
      expect(await status.getAttribute('aria-live')).toBe('polite');
      await sheet.focus();
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => status.textContent()).toBe('Bar 1, beat 1, note C5, quarter');
      if (process.env['SHOT_DIR'] !== undefined) await page.screenshot({ path: `${process.env['SHOT_DIR']}/a11y-focused-sheet.png` });
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => status.textContent()).toBe('Bar 1, beat 2, note G4, half');

      // An edit is announced, and focus is still on the sheet afterwards, not lost to the page.
      await page.keyboard.press('Delete');
      await expect.poll(() => status.textContent(), { timeout: 20_000 }).toBe('Deleted 1 item');
      expect(await page.evaluate(() => document.activeElement?.classList.contains('sheet'))).toBe(true);

      // Undo is announced.
      await page.keyboard.press('Control+z');
      await expect.poll(() => status.textContent(), { timeout: 20_000 }).toBe('Undone');

      // A rail control that vanishes with the selection hands focus back to the sheet.
      await sheet.focus();
      await page.keyboard.press('ArrowRight');
      await page.getByRole('button', { name: 'Deselect' }).first().focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('sheet'))).toBe(true);

      // The ? overlay takes focus and gives it back to where it was.
      await sheet.focus();
      await page.keyboard.press('?');
      const overlay = page.getByTestId('shortcuts');
      await overlay.waitFor({ timeout: 5_000 });
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Close shortcuts');
      await page.keyboard.press('Escape');
      await overlay.waitFor({ state: 'hidden', timeout: 5_000 });
      expect(await page.evaluate(() => document.activeElement?.classList.contains('sheet'))).toBe(true);
    } finally {
      await page.close();
    }
  }, 120_000);
});
