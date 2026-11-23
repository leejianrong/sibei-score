import { DEFAULT_MUSIC_FONT } from '@sibei/engrave';
import type { Score } from '@sibei/model';
import { loadFont, pageItemBoxes, renderScorePages } from '@sibei/ui';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/stack.js';

/**
 * Selecting many notes and editing them at once (SIB2-278, Q79): shift-click a range, ctrl-click to add, act on all of
 * it, and one ctrl-Z reverses the whole edit. Assertions read the stored document through the CLI.
 */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 90_000);

afterAll(async () => {
  await stack?.stop();
});

interface Doc {
  score: { parts: { staves: { bars: { voices: { items: { kind: string; pitch?: { step: string; alter: number; octave: number } }[] }[] }[] }[] }[] };
}

function pitches(id: string): string[] {
  const doc = stack.cli(['open', id]) as Doc;
  return doc.score.parts[0]!.staves[0]!.bars.flatMap((bar) => bar.voices[0]!.items.map((item) => `${item.pitch!.step}${item.pitch!.octave}`));
}

/** Where the nth note of the chart sits on its sheet, as fractions of the sheet's box. */
function noteTarget(score: Score, nth: number): { pageIndex: number; cx: number; cy: number } {
  const pages = renderScorePages(score, { paper: 'a4' }, { font: DEFAULT_MUSIC_FONT });
  const font = loadFont(DEFAULT_MUSIC_FONT);
  const boxes = pages.flatMap((page, pageIndex) => pageItemBoxes(page.layout, font).filter((box) => box.kind === 'note').map((box) => ({ page, pageIndex, box })));
  const found = boxes[nth]!;
  return {
    pageIndex: found.pageIndex,
    cx: (found.box.x + found.box.width / 2) / found.page.layout.width,
    cy: (found.box.y + found.box.height / 2) / found.page.layout.height,
  };
}

async function clickNote(page: Page, score: Score, nth: number, modifiers: ('Shift' | 'Control')[] = []): Promise<void> {
  const target = noteTarget(score, nth);
  const sheet = page.locator('.sheet').nth(target.pageIndex);
  const box = await sheet.boundingBox();
  if (box === null) throw new Error('no sheet box');
  await sheet.click({ position: { x: target.cx * box.width, y: target.cy * box.height }, modifiers });
}

describe('multi-selection', () => {
  it('selects a range and an added note, edits them in one batch, and undoes it in one ctrl-Z', async () => {
    const id = 'e2e-selection';
    stack.cli(['new', '--id', id, '--title', 'Sel', '--key', 'C', '--bars', '2']);
    const notes: [string, string][] = [['bar1.beat1', 'C4'], ['bar1.beat2', 'D4'], ['bar1.beat3', 'E4'], ['bar1.beat4', 'F4'], ['bar2.beat1', 'G4']];
    for (const [where, pitch] of notes) stack.cli(['note', 'add', id, where, '--pitch', pitch, '--dur', '4']);
    const score = (stack.cli(['open', id]) as { score: Score }).score;
    const page = await stack.browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(stack.scoreUrl(id), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sheet');
    try {
      await clickNote(page, score, 0);
      await clickNote(page, score, 2, ['Shift']);
      await page.getByTestId('selection-panel').waitFor({ timeout: 5_000 });
      expect(await page.getByTestId('selection-count').textContent()).toContain('3 items');

      await clickNote(page, score, 4, ['Control']);
      await expect.poll(async () => page.getByTestId('selection-count').textContent()).toContain('4 items');

      await page.getByRole('button', { name: 'Up a step', exact: true }).click();
      await expect.poll(() => pitches(id), { timeout: 20_000 }).toEqual(['D4', 'E4', 'F4', 'F4', 'A4']);

      // One batch is one undo.
      await page.keyboard.press('Control+z');
      await expect.poll(() => pitches(id), { timeout: 20_000 }).toEqual(['C4', 'D4', 'E4', 'F4', 'G4']);

      // Select all in the staff, then delete them as one unit.
      await page.keyboard.press('Control+a');
      await expect.poll(async () => page.getByTestId('selection-count').textContent()).toContain('5 items');
      await page.getByRole('button', { name: 'Delete selection', exact: true }).click();
      await expect.poll(() => (stack.cli(['open', id]) as Doc).score.parts[0]!.staves[0]!.bars.flatMap((bar) => bar.voices[0]!.items.filter((item) => item.kind === 'note')).length, { timeout: 20_000 }).toBe(0);
      await page.keyboard.press('Control+z');
      await expect.poll(() => pitches(id), { timeout: 20_000 }).toEqual(['C4', 'D4', 'E4', 'F4', 'G4']);
    } finally {
      await page.close();
    }
  }, 180_000);
});
