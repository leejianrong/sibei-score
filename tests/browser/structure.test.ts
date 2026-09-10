import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Score } from '@sibei/model';
import { barTarget } from './support/geometry.js';
import { startStack, type Stack } from './support/stack.js';

/**
 * V7c end-to-end: a bar's structure, set in the browser, reaches the store and the engraving — the
 * same "two clients of one API cannot disagree" property V4d/V5e proved for notes and chords, now
 * for the section, barlines and endings the Structure panel drives. It boots the whole stack and
 * drives a real browser: the panel's controls, the click-to-select-a-bar hit-test and the batch of
 * ops it posts are exactly the things a jsdom simulation would pass on while the product was broken.
 *
 * The browser renders through the same `layout` + `engrave` the PDF goes through, so a rehearsal
 * mark or a double barline that appears on the sheet here is one that appears in the print.
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

/** Click a bar's staff (clear of its notes) and wait for the Structure panel to arrive. */
async function clickBar(page: Page, cx: number, cy: number, pageIndex = 0): Promise<void> {
  const sheet = page.locator('.sheet').nth(pageIndex);
  const box = await sheet.boundingBox();
  if (box === null) throw new Error('the sheet has no box on screen');
  await sheet.click({ position: { x: cx * box.width, y: cy * box.height } });
  await page.getByLabel('Rehearsal letter').waitFor({ timeout: 5_000 });
}

interface Bar {
  number: number;
  endBarline: string;
  ending: { numbers: number[]; role: string } | null;
}
interface Doc {
  score: { bars: Bar[]; sections: { startBar: number; letter: string | null; name: string | null }[] };
}

describe('bar structure, set in the browser over a live stack (V7c)', () => {
  it('sets a section, a barline and an ending on a bar; the CLI reads them and the sheet engraves them', async () => {
    const id = 'e2e-structure';
    stack.cli(['new', '--id', id, '--title', 'Structure', '--key', 'C', '--bars', '4']);
    // A note in bar 1 gives the sheet ink; bar 2 stays empty so a click there lands on the bar.
    stack.cli(['note', 'add', id, 'bar1.beat1', '--pitch', 'C5', '--dur', '4']);
    const opened = stack.cli(['open', id]) as { score: Score };
    const target = barTarget(opened.score, 2);

    const page = await openScore(id);
    try {
      await expect.poll(() => railVersion(page)).toBe('v2');

      await clickBar(page, target.cx, target.cy, target.pageIndex);

      // The panel: a rehearsal letter, a closing double bar, and a one-bar 1st ending.
      await page.getByLabel('Rehearsal letter').fill('B');
      await page.getByRole('group', { name: 'Closing barline' }).getByRole('button', { name: 'Double' }).click();
      await page.getByRole('group', { name: 'Ending role' }).getByRole('button', { name: '1 bar' }).click();
      await page.getByRole('button', { name: 'Save' }).click();

      // The browser re-reads after the write, so its version moves (one batch, whatever its length).
      await expect.poll(() => railVersion(page)).toBe('v3');

      // The store has all three, on bar 2, as the CLI reads them back.
      const doc = stack.cli(['open', id]) as Doc;
      expect(doc.score.sections.find((s) => s.startBar === 2)).toMatchObject({ letter: 'B', name: null });
      const bar2 = doc.score.bars.find((b) => b.number === 2)!;
      expect(bar2.endBarline).toBe('double');
      expect(bar2.ending).toEqual({ numbers: [1], role: 'start-stop' });

      // And they are engraved on the sheet — the same layout+engrave the PDF uses.
      await expect.poll(() => page.locator('.se-rehearsalmark').allTextContents()).toContain('B');
      await expect.poll(() => page.locator('.se-barline-double').count()).toBeGreaterThan(0);
      await expect.poll(() => page.locator('.se-endingnumber').count()).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });

  it('removes a section when its letter and name are cleared', async () => {
    const id = 'e2e-structure-rm';
    stack.cli(['new', '--id', id, '--title', 'Structure', '--key', 'C', '--bars', '4']);
    stack.cli(['section', 'set', id, 'bar2', '--letter', 'B']);
    const opened = stack.cli(['open', id]) as { score: Score };
    const target = barTarget(opened.score, 2);

    const page = await openScore(id);
    try {
      await expect.poll(() => railVersion(page)).toBe('v2');
      await clickBar(page, target.cx, target.cy, target.pageIndex);

      // Clear the letter it carries, then Save: both fields empty means no section here.
      await page.getByLabel('Rehearsal letter').fill('');
      await page.getByRole('button', { name: 'Save' }).click();

      await expect.poll(() => railVersion(page)).toBe('v3');
      const doc = stack.cli(['open', id]) as Doc;
      expect(doc.score.sections).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
