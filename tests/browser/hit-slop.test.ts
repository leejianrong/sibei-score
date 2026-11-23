import { DEFAULT_MUSIC_FONT } from '@sibei/engrave';
import type { Score } from '@sibei/model';
import { loadFont, pageItemBoxes, renderScorePages } from '@sibei/ui';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/stack.js';

/**
 * SIB2-275: a click a few pixels off a notehead selects the note, not the bar behind it, at 100% and at 50% zoom, and the
 * selection is drawn clearly enough to see. The click point is derived from the app's own geometry (as `selection.test`).
 */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 90_000);

afterAll(async () => {
  await stack?.stop();
});

describe('hit slop on a real sheet (SIB2-275)', () => {
  it('selects the note for a click 7 px to its left at 100% and the 60% minimum zoom', async () => {
    const id = 'e2e-hit-slop';
    stack.cli(['new', '--id', id, '--title', 'Slop', '--key', 'C', '--bars', '4']);
    for (const [where, pitch] of [['bar1.beat1', 'C5'], ['bar1.beat3', 'E5'], ['bar2.beat1', 'G4']] as const) {
      stack.cli(['note', 'add', id, where, '--pitch', pitch, '--dur', '4']);
    }
    const score = (stack.cli(['open', id]) as { score: Score }).score;
    const pages = renderScorePages(score, { paper: 'a4' }, { font: DEFAULT_MUSIC_FONT });
    const note = pageItemBoxes(pages[0]!.layout, loadFont(DEFAULT_MUSIC_FONT)).filter((box) => box.kind === 'note')[1]!;
    const layoutWidth = pages[0]!.layout.width;
    const layoutHeight = pages[0]!.layout.height;

    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const page = await stack.browser.newPage({ viewport: { width, height } });
      try {
        await page.goto(stack.scoreUrl(id), { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.sheet');
        for (const zoomOuts of [0, 2]) {
          for (let step = 0; step < zoomOuts; step += 1) await page.getByRole('button', { name: 'Zoom out' }).click();
          const zoomText = (await page.locator('.zoom .val').textContent())!.trim();
          const sheet = page.locator('.sheet').first();
          await sheet.scrollIntoViewIfNeeded();
          const box = (await sheet.boundingBox())!;
          const perUnit = box.width / layoutWidth;
          const x = note.x * perUnit - 7;
          const y = (note.y + note.height / 2) * (box.height / layoutHeight);
          await page.mouse.click(box.x + x, box.y + y);
          await page.getByTestId('selected-pane').waitFor({ timeout: 5_000 });
          expect(await page.getByTestId('selected-pane').textContent(), `${zoomText} at ${width}`).toContain('Note');
          // The selection ring is a visible overlay, with a solid outline at least 2 px thick.
          const ring = page.locator('.hit.selected').first();
          await ring.waitFor();
          const outline = await ring.evaluate((el) => getComputedStyle(el).outlineWidth);
          expect(parseFloat(outline)).toBeGreaterThanOrEqual(2);
          await page.screenshot({ path: `${process.env['SHOT_DIR'] ?? '/tmp'}/hit-slop-${width}-${zoomText.replace('%', '')}.png` });
        }
      } finally {
        await page.close();
      }
    }
  }, 120_000);
});
