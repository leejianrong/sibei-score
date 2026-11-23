import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { barViews } from '@sibei/model';
import type { Score } from '@sibei/model';
import { barTarget } from './support/geometry.js';
import { startStack, type Stack } from './support/stack.js';

/**
 * SIB2-265: the New note form keeps going. After an add the bar stays selected, the beat field moves on by the
 * duration just entered (dots included) and the pitch field keeps the focus, so four quarter notes are one bar click.
 */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 90_000);

afterAll(async () => {
  await stack?.stop();
});

describe('entering notes from the bar panel (SIB2-265)', () => {
  it('enters four quarters with one bar click, advancing the beat and keeping focus in the pitch field', async () => {
    const id = 'entry-continues';
    stack.cli(['new', '--id', id, '--title', 'Entry', '--key', 'C', '--bars', '4']);
    const { score } = stack.cli(['open', id]) as { score: Score };
    const page = await stack.browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(stack.scoreUrl(id), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sheet');
      const sheet = page.locator('.sheet').first();
      const box = (await sheet.boundingBox())!;
      const bar = barTarget(score, 2);
      await sheet.click({ position: { x: bar.cx * box.width, y: bar.cy * box.height } });

      const pitch = page.getByLabel('Name of the new note', { exact: true });
      const beat = page.getByLabel('Beat of the new item', { exact: true });
      const version = (): Promise<string> => page.locator('dt:text-is("version") + dd').innerText();

      for (const [index, name] of ['C4', 'D4', 'E4', 'F4'].entries()) {
        expect(await beat.inputValue()).toBe(String(index + 1));
        await pitch.fill(name);
        await page.getByRole('button', { name: 'New note', exact: true }).click();
        await expect.poll(version).toBe(`v${index + 2}`);
        // Still in the same bar panel, and the pitch field is where typing continues.
        expect(await pitch.isVisible()).toBe(true);
        expect(await pitch.evaluate((el) => el === document.activeElement)).toBe(true);
      }

      const opened = stack.cli(['open', id]) as { score: Score };
      const notes = barViews(opened.score)[1]!.items.filter((item) => item.kind === 'note');
      expect(notes).toHaveLength(4);
    } finally {
      await page.close();
    }
  });
});
