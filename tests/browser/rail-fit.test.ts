import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Score } from '@sibei/model';
import { firstNoteTarget } from './support/geometry.js';
import { openRailPanels } from './support/rail.js';
import { startStack, type Stack } from './support/stack.js';

/**
 * SIB2-276: no control in the rail extends past its right edge. A native `<select>` is as wide as its longest
 * option, so the Part select ("Concert score — as stored") used to run out of the rail and be clipped. Measured in a
 * real browser at the two widths the app is designed for, with every panel open and a note selected so the inspector's
 * own selects are in the rail too.
 */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 90_000);

afterAll(async () => {
  await stack?.stop();
});

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const) {
  describe(`the rail at ${width} wide (SIB2-276)`, () => {
    it('keeps every control inside the rail', async () => {
      const id = `rail-fit-${width}`;
      stack.cli(['new', '--id', id, '--title', 'Fit', '--key', 'C', '--bars', '4']);
      stack.cli(['note', 'add', id, 'bar1.beat1', '--pitch', 'C5', '--dur', '4']);
      const { score } = stack.cli(['open', id]) as { score: Score };
      const page = await stack.browser.newPage({ viewport: { width, height } });
      try {
        await page.goto(stack.scoreUrl(id), { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.sheet');
        const target = firstNoteTarget(score);
        const sheet = page.locator('.sheet').first();
        const box = (await sheet.boundingBox())!;
        await sheet.click({ position: { x: target.cx * box.width, y: target.cy * box.height } });
        await page.getByTestId('selected-pane').waitFor();
        await openRailPanels(page);
        const overflowing = await page.evaluate(() => {
          const rail = document.querySelector('.rail')!.getBoundingClientRect();
          const out: string[] = [];
          for (const el of document.querySelectorAll<HTMLElement>('.rail select, .rail input, .rail textarea, .rail button, .rail a')) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.right > rail.right + 0.5) out.push(`${el.tagName} ${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30)} right=${r.right} rail=${rail.right}`);
          }
          return out;
        });
        expect(overflowing).toEqual([]);
        await page.screenshot({ path: `${process.env['SHOT_DIR'] ?? '/tmp'}/rail-fit-${width}.png` });
      } finally {
        await page.close();
      }
    });
  });
}
