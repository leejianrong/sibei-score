import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Score } from '@sibei/model';
import { barTarget, firstNoteTarget } from './support/geometry.js';
import { startStack, type Stack } from './support/stack.js';

/**
 * SIB2-263: selecting something on the sheet puts its inspector in view. The Selected region sits directly
 * under the title at the top of the rail (it used to be the last of fifteen panels, thousands of pixels down),
 * so a click's first control is inside the viewport with no scrolling.
 */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 90_000);

afterAll(async () => {
  await stack?.stop();
});

describe('the Selected inspector is in view after a click (SIB2-263)', () => {
  it('shows the first control of a note and of a bar inside the viewport', async () => {
    const id = 'rail-selection';
    stack.cli(['new', '--id', id, '--title', 'Rail', '--key', 'C', '--bars', '32']);
    stack.cli(['note', 'add', id, 'bar1.beat1', '--pitch', 'C5', '--dur', '4']);
    const { score } = stack.cli(['open', id]) as { score: Score };

    const page = await stack.browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(stack.scoreUrl(id), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sheet');
      const sheet = page.locator('.sheet').first();
      const pane = page.getByTestId('selected-pane');

      const inViewport = async (): Promise<boolean> => {
        const first = pane.locator('input, button, select').first();
        await first.waitFor();
        const box = await first.boundingBox();
        return box !== null && box.y >= 0 && box.y + box.height <= 900;
      };

      const note = firstNoteTarget(score);
      let box = (await sheet.boundingBox())!;
      await sheet.click({ position: { x: note.cx * box.width, y: note.cy * box.height } });
      await expect.poll(inViewport).toBe(true);

      const bar = barTarget(score, 2);
      box = (await sheet.boundingBox())!;
      await sheet.click({ position: { x: bar.cx * box.width, y: bar.cy * box.height } });
      await page.getByLabel('Rehearsal letter').waitFor();
      await expect.poll(inViewport).toBe(true);
      const letter = await page.getByLabel('Rehearsal letter').boundingBox();
      expect(letter!.y + letter!.height).toBeLessThanOrEqual(900);
    } finally {
      await page.close();
    }
  });
});
