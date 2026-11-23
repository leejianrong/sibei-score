import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/stack.js';

/**
 * Keyboard note input in the browser (SIB2-155, Q79): open the mode, type a four-bar melody with the keyboard alone, and
 * read the stored document back through the CLI. Every note is an ordinary op, so ctrl-Z undoes one note at a time and the
 * op log holds `note.add`s a CLI user could have typed.
 */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 90_000);

afterAll(async () => {
  await stack?.stop();
});

interface Item {
  kind: string;
  pitch?: { step: string; alter: number; octave: number };
  duration: { value: number; dots: number };
  tie?: string;
}
interface Doc {
  score: { parts: { staves: { bars: { voices: { items: Item[] }[] }[] }[] }[] };
}

function melody(id: string): string[][] {
  const doc = stack.cli(['open', id]) as Doc;
  return doc.score.parts[0]!.staves[0]!.bars.map((bar) =>
    bar.voices[0]!.items.map((item) =>
      item.kind === 'rest' ? `r${item.duration.value}` : `${item.pitch!.step}${item.pitch!.alter === 1 ? '#' : item.pitch!.alter === -1 ? 'b' : ''}${item.pitch!.octave}/${item.duration.value}`,
    ),
  );
}

async function openScore(id: string): Promise<Page> {
  const page = await stack.browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(stack.scoreUrl(id), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sheet');
  return page;
}

describe('keyboard note input', () => {
  it('enters a four-bar melody without the mouse, shows the caret and ghost, and undoes one note per ctrl-Z', async () => {
    const id = 'e2e-note-input';
    stack.cli(['new', '--id', id, '--title', 'Typed', '--key', 'C', '--bars', '4']);
    const page = await openScore(id);
    try {
      // N opens the mode: the keypad and the previewed note at the caret appear.
      await page.keyboard.press('n');
      const panel = page.getByTestId('note-input-panel');
      await panel.waitFor({ timeout: 10_000 });
      await expect.poll(async () => page.getByTestId('note-input-caret').textContent()).toContain('bar 1');
      await page.getByTestId('note-input-ghost').waitFor({ timeout: 5_000 });

      // The digits are durations inside the mode.
      await page.keyboard.type('4cdefgabc');
      await page.keyboard.press('2');
      await page.keyboard.type('gfed');
      await page.keyboard.press('4');
      await page.keyboard.type('c');
      await expect
        .poll(() => melody(id).flat().length, { timeout: 30_000 })
        .toBe(4 + 4 + 4 + 1);
      expect(melody(id)[0]).toEqual(['C5/4', 'D5/4', 'E5/4', 'F5/4']);
      expect(melody(id)[1]).toEqual(['G5/4', 'A5/4', 'B5/4', 'C6/4']);

      // Space skips, Backspace deletes the previous note and steps back, then the note is re-entered.
      await page.keyboard.press('Backspace');
      await expect.poll(() => melody(id).flat().length, { timeout: 15_000 }).toBe(12);

      // The log is ordinary ops: ctrl-Z undoes just the last one.
      const before = melody(id).flat().length;
      await page.keyboard.press('Control+z');
      await expect.poll(() => melody(id).flat().length, { timeout: 15_000 }).toBe(before + 1);

      // Esc leaves the mode; a digit is a voice key again (a no-op on a one-lane chart) and enters nothing.
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'hidden', timeout: 5_000 });
      const count = melody(id).flat().length;
      await page.keyboard.press('c');
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(melody(id).flat().length).toBe(count);
    } finally {
      await page.close();
    }
  }, 180_000);

  it('adds a chord with shift+letter, ties across, and the ? overlay documents the digit rule', async () => {
    const id = 'e2e-note-input-chord';
    stack.cli(['new', '--id', id, '--title', 'Chords', '--key', 'C', '--bars', '2']);
    const page = await openScore(id);
    try {
      await page.keyboard.press('?');
      const overlay = page.getByTestId('shortcuts');
      await overlay.waitFor({ timeout: 5_000 });
      expect(await overlay.textContent()).toContain('Inside note input the digits are note values, not voices');
      await page.keyboard.press('Escape');
      await overlay.waitFor({ state: 'hidden', timeout: 5_000 });

      await page.getByRole('button', { name: 'Note input', exact: true }).click();
      await page.getByTestId('note-input-panel').waitFor({ timeout: 10_000 });
      await page.keyboard.type('4c');
      await page.keyboard.press('Shift+G');
      await page.keyboard.type('t');
      await page.keyboard.type('c');
      await expect.poll(() => melody(id)[0]!.length, { timeout: 20_000 }).toBe(2);
      const first = (stack.cli(['open', id]) as Doc).score.parts[0]!.staves[0]!.bars[0]!.voices[0]!.items;
      expect(first[0]!.tie).toBe('start');
      expect(first[1]!.tie).toBe('stop');
    } finally {
      await page.close();
    }
  }, 120_000);

  it('does not wash the bar being typed into rose, and does once the mode is left (SIB2-280)', async () => {
    const id = 'e2e-note-input-wash';
    stack.cli(['new', '--id', id, '--title', 'Wash', '--key', 'C', '--bars', '4']);
    const page = await openScore(id);
    try {
      const washes = (): Promise<number> => page.locator('.sheet .se-invalidbar').count();
      await page.getByRole('button', { name: 'Note input', exact: true }).click();
      await page.getByTestId('note-input-panel').waitFor({ timeout: 10_000 });
      await page.keyboard.type('4c');
      await expect.poll(() => melody(id)[0]!.length, { timeout: 20_000 }).toBe(1);
      await page.getByTestId('note-input-ghost').waitFor({ timeout: 5_000 });
      // One quarter in a 4/4 bar plus the ghost: under-filled, but still being typed.
      expect(await washes()).toBe(0);
      await page.keyboard.press('Escape');
      await expect.poll(washes, { timeout: 10_000 }).toBe(1);
    } finally {
      await page.close();
    }
  }, 120_000);
});
