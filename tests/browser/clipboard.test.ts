import { DEFAULT_MUSIC_FONT } from '@sibei/engrave';
import type { Score } from '@sibei/model';
import { barAt, loadFont, pageBarBoxes, pageItemBoxes, renderScorePages } from '@sibei/ui';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/stack.js';

/**
 * Copy, cut, paste and duplicate in the browser (SIB2-279, Q79): select notes, Ctrl-C, select a bar, Ctrl-V, and read the
 * stored document back through the CLI. A paste is one `range.paste` op, so one ctrl-Z reverses it.
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

function bars(id: string): string[][] {
  const doc = stack.cli(['open', id]) as Doc;
  return doc.score.parts[0]!.staves[0]!.bars.map((bar) => bar.voices[0]!.items.filter((item) => item.kind === 'note').map((item) => `${item.pitch!.step}${item.pitch!.octave}`));
}

async function sheetPoint(page: Page, fx: number, fy: number, pageIndex: number, modifiers: ('Shift' | 'Control')[] = []): Promise<void> {
  const sheet = page.locator('.sheet').nth(pageIndex);
  const box = await sheet.boundingBox();
  if (box === null) throw new Error('no sheet box');
  await sheet.click({ position: { x: fx * box.width, y: fy * box.height }, modifiers });
}

describe('copy and paste', () => {
  it('copies four notes, pastes them into another bar with ctrl-V, and one ctrl-Z takes the paste back', async () => {
    const id = 'e2e-clipboard';
    stack.cli(['new', '--id', id, '--title', 'Clip', '--key', 'C', '--bars', '4']);
    for (const [at, pitch] of [['bar1.beat1', 'C5'], ['bar1.beat2', 'D5'], ['bar1.beat3', 'E5'], ['bar1.beat4', 'F5']]) {
      stack.cli(['note', 'add', id, at!, '--pitch', pitch!, '--dur', '4']);
    }
    const score = (stack.cli(['open', id]) as unknown as { score: Score }).score;
    const pages = renderScorePages(score, { paper: 'a4' }, { font: DEFAULT_MUSIC_FONT });
    const layoutPage = pages[0]!.layout;
    const notes = pageItemBoxes(layoutPage, loadFont(DEFAULT_MUSIC_FONT)).filter((box) => box.kind === 'note');
    const bar3 = pageBarBoxes(layoutPage).find((box) => box.barNumber === 3)!;
    expect(barAt([bar3], { x: bar3.x + bar3.width / 2, y: bar3.y + bar3.height / 2 })?.barNumber).toBe(3);
    const frac = (x: number, y: number): [number, number] => [x / layoutPage.width, y / layoutPage.height];

    const page = await stack.browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(stack.scoreUrl(id), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sheet');
    try {
      const first = notes[0]!;
      const last = notes[3]!;
      await sheetPoint(page, ...frac(first.x + first.width / 2, first.y + first.height / 2), 0);
      await sheetPoint(page, ...frac(last.x + last.width / 2, last.y + last.height / 2), 0, ['Shift']);
      await page.getByTestId('selection-panel').waitFor({ timeout: 5_000 });

      await page.keyboard.press('Control+c');
      await expect.poll(async () => page.getByTestId('clip-note').textContent(), { timeout: 5_000 }).toContain('Copied 4 notes');

      // Select bar 3 by clicking its empty staff, then paste.
      await sheetPoint(page, ...frac(bar3.x + bar3.width / 2, bar3.y + bar3.height / 2), 0);
      await page.keyboard.press('Control+v');
      await expect.poll(() => bars(id)[2], { timeout: 20_000 }).toEqual(['C5', 'D5', 'E5', 'F5']);
      expect(bars(id)[0]).toEqual(['C5', 'D5', 'E5', 'F5']);

      await page.keyboard.press('Control+z');
      await expect.poll(() => bars(id)[2], { timeout: 20_000 }).toEqual([]);
    } finally {
      await page.close();
    }
  }, 180_000);

  it('duplicates a selection right after itself with the Duplicate button', async () => {
    const id = 'e2e-clipboard-dup';
    stack.cli(['new', '--id', id, '--title', 'Dup', '--key', 'C', '--bars', '4']);
    for (const [at, pitch] of [['bar1.beat1', 'C5'], ['bar1.beat2', 'D5'], ['bar1.beat3', 'E5'], ['bar1.beat4', 'F5']]) {
      stack.cli(['note', 'add', id, at!, '--pitch', pitch!, '--dur', '4']);
    }
    const score = (stack.cli(['open', id]) as unknown as { score: Score }).score;
    const layoutPage = renderScorePages(score, { paper: 'a4' }, { font: DEFAULT_MUSIC_FONT })[0]!.layout;
    const notes = pageItemBoxes(layoutPage, loadFont(DEFAULT_MUSIC_FONT)).filter((box) => box.kind === 'note');
    const frac = (x: number, y: number): [number, number] => [x / layoutPage.width, y / layoutPage.height];
    const page = await stack.browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(stack.scoreUrl(id), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sheet');
    try {
      const first = notes[0]!;
      const last = notes[3]!;
      await sheetPoint(page, ...frac(first.x + first.width / 2, first.y + first.height / 2), 0);
      await sheetPoint(page, ...frac(last.x + last.width / 2, last.y + last.height / 2), 0, ['Shift']);
      await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
      await expect.poll(() => bars(id)[1], { timeout: 20_000 }).toEqual(['C5', 'D5', 'E5', 'F5']);
    } finally {
      await page.close();
    }
  }, 120_000);
});
