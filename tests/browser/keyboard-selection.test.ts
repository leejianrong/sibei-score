import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/stack.js';

/**
 * SIB2-268: selecting and editing from the keyboard alone. Tab reaches the sheet, the arrows walk the notes (Ctrl/Cmd and
 * the arrows a bar at a time), Delete removes the selection, Escape clears it, and `?` lists the bindings.
 */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 90_000);

afterAll(async () => {
  await stack?.stop();
});

interface Doc {
  score: { parts: { staves: { bars: { voices: { items: { kind: string; pitch?: { step: string; octave: number } }[] }[] }[] }[] }[] };
}

function pitches(id: string): string[] {
  const doc = stack.cli(['open', id]) as Doc;
  return doc.score.parts[0]!.staves[0]!.bars.flatMap((bar) => bar.voices[0]!.items.map((item) => `${item.pitch!.step}${item.pitch!.octave}`));
}

describe('the sheet from the keyboard (SIB2-268)', () => {
  it('Tab reaches the sheet; arrows move the selection; Delete removes; Escape clears', async () => {
    const id = 'e2e-keys';
    stack.cli(['new', '--id', id, '--title', 'Keys', '--key', 'C', '--bars', '4']);
    for (const [where, pitch] of [['bar1.beat1', 'C5'], ['bar1.beat2', 'D5'], ['bar2.beat1', 'E5'], ['bar2.beat2', 'F5']] as const) {
      stack.cli(['note', 'add', id, where, '--pitch', pitch, '--dur', '4']);
    }
    const page = await stack.browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(stack.scoreUrl(id), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sheet');

      // Tab reaches the sheet.
      let reached = false;
      for (let presses = 0; presses < 120 && !reached; presses += 1) {
        await page.keyboard.press('Tab');
        reached = await page.evaluate(() => document.activeElement?.classList.contains('sheet') === true);
      }
      expect(reached).toBe(true);

      const selected = async (): Promise<string> => {
        const pane = page.getByTestId('selected-pane');
        await pane.waitFor({ timeout: 5_000 });
        return /note-\d+/.exec((await pane.textContent()) ?? '')?.[0] ?? '';
      };

      // Nothing selected: Right takes the first note, and the next ones follow it.
      await page.keyboard.press('ArrowRight');
      const first = await selected();
      await page.keyboard.press('ArrowRight');
      await expect.poll(selected).not.toBe(first);
      const second = await selected();
      await page.keyboard.press('ArrowLeft');
      await expect.poll(selected).toBe(first);

      // Ctrl+Right jumps a bar: from the first note of bar 1 to the first of bar 2.
      await page.keyboard.press('Control+ArrowRight');
      await expect.poll(selected).not.toBe(second);
      const barTwo = await selected();
      await page.keyboard.press('ArrowRight');
      await expect.poll(selected).not.toBe(barTwo);
      await page.keyboard.press('Control+ArrowLeft');
      await expect.poll(selected).toBe(first);

      // Delete removes the selected note; the store says so.
      await page.keyboard.press('ArrowRight');
      await expect.poll(selected).toBe(second);
      await page.keyboard.press('Delete');
      await expect.poll(() => pitches(id), { timeout: 20_000 }).toEqual(['C5', 'E5', 'F5']);

      // Escape clears the selection.
      await page.keyboard.press('ArrowRight');
      await page.getByTestId('selected-pane').waitFor({ timeout: 5_000 });
      await page.keyboard.press('Escape');
      await expect.poll(async () => page.getByTestId('selected-pane').textContent(), { timeout: 5_000 }).toContain('Nothing selected');
      expect(pitches(id)).toEqual(['C5', 'E5', 'F5']);
    } finally {
      await page.close();
    }
  }, 120_000);

  it('leaves a focused select its own arrow keys', async () => {
    const id = 'e2e-keys-select';
    stack.cli(['new', '--id', id, '--title', 'Keys2', '--key', 'C', '--bars', '2']);
    stack.cli(['note', 'add', id, 'bar1.beat1', '--pitch', 'C5', '--dur', '4']);
    stack.cli(['note', 'add', id, 'bar1.beat2', '--pitch', 'D5', '--dur', '4']);
    const page = await stack.browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(stack.scoreUrl(id), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sheet');
      await page.locator('.sheet').first().focus();
      await page.keyboard.press('ArrowRight');
      await page.getByTestId('selected-pane').waitFor({ timeout: 5_000 });
      const before = (await page.getByTestId('selected-pane').textContent()) ?? '';
      await page.locator('select[aria-label="Instrument part"]').focus();
      await page.keyboard.press('Delete');
      expect((await page.getByTestId('selected-pane').textContent()) ?? '').toBe(before);
      expect((stack.cli(['open', id]) as Doc).score.parts[0]!.staves[0]!.bars[0]!.voices[0]!.items).toHaveLength(2);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('lists every binding in the ? overlay', async () => {
    const id = 'e2e-keys-help';
    stack.cli(['new', '--id', id, '--title', 'Keys3', '--key', 'C', '--bars', '2']);
    const page = await stack.browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(stack.scoreUrl(id), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sheet');
      await page.keyboard.press('?');
      const overlay = page.getByTestId('shortcuts');
      await overlay.waitFor({ timeout: 5_000 });
      const text = (await overlay.textContent()) ?? '';
      for (const needle of ['Move the selection to the next note or rest in the voice', 'Jump to the first note of the next bar', 'Delete the selected note', 'Clear the selection']) {
        expect(text).toContain(needle);
      }
      await page.keyboard.press('Escape');
      await overlay.waitFor({ state: 'hidden', timeout: 5_000 });
    } finally {
      await page.close();
    }
  }, 60_000);
});
