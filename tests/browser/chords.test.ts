import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chordBandTarget, firstChordTarget } from './support/geometry.js';
import { startStack, type Stack } from './support/stack.js';

/**
 * V5e end-to-end: a chord entered in the browser reaches the store, the text projection and the
 * engraving — the same "two clients of one API cannot disagree" property V4d proved for notes,
 * now for chords (SLICES.md V5, "A chord entered in the browser appears in the PDF, in the text
 * projection, and via the CLI at the same beat"). It boots the whole stack and drives a real
 * browser for the same reason V4d does: a jsdom simulation would pass while the product is broken.
 *
 * The browser renders through the same `layout` + `engrave` the PDF goes through (a byte-identical
 * test pins that), so a chord that appears engraved on the sheet here is a chord that appears in the
 * PDF — asserting the `ø` glyph on screen is asserting the print.
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

/** Click the chord band above a bar at a beat, and wait for the chord field to arrive. */
async function clickBand(page: Page, cx: number, cy: number, pageIndex = 0): Promise<void> {
  const sheet = page.locator('.sheet').nth(pageIndex);
  const box = await sheet.boundingBox();
  if (box === null) throw new Error('the sheet has no box on screen');
  await sheet.click({ position: { x: cx * box.width, y: cy * box.height } });
  await page.getByLabel('Chord symbol').waitFor({ timeout: 5_000 });
}

function authorChart(id: string): void {
  stack.cli(['new', '--id', id, '--title', 'Chords', '--key', 'Eb', '--bars', '4']);
  // A note at bar 1 beat 1 gives the band something to anchor to and the sheet some ink.
  stack.cli(['note', 'add', id, 'bar1.beat1', '--pitch', 'Eb5', '--dur', '4']);
}

describe('chords, entered in the browser over a live stack (V5e)', () => {
  it('adds a chord from the band above a bar; the CLI reads it and the sheet engraves it', async () => {
    const id = 'e2e-chord-add';
    authorChart(id);
    const opened = stack.cli(['open', id]) as { score: Parameters<typeof chordBandTarget>[0] };
    const target = chordBandTarget(opened.score, 1, 1);

    const page = await openScore(id);
    try {
      await expect.poll(() => railVersion(page)).toBe('v2');

      await clickBand(page, target.cx, target.cy);
      await page.getByLabel('Chord symbol').fill('F#m7b5');
      await page.getByRole('button', { name: 'Add' }).click();

      // The browser re-reads after the write, so its version moves.
      await expect.poll(() => railVersion(page)).toBe('v3');

      // The store has it, at the beat, as the CLI reads it back.
      const shown = stack.cli(['show', id]) as { projection: string };
      expect(shown.projection).toContain('F#m7b5');

      // And it is engraved on the sheet with jazz typography — the ø of a half-diminished chord.
      // Same layout+engrave the PDF uses, so this is the print too.
      await expect.poll(() => page.locator('.se-chord').first().textContent()).toContain('ø');
    } finally {
      await page.close();
    }
  });

  it('edits an existing chord by clicking it, and removes it', async () => {
    const id = 'e2e-chord-edit';
    authorChart(id);
    stack.cli(['chord', 'set', id, 'bar1.beat1', '--text', 'Cmaj7']);
    const opened = stack.cli(['open', id]) as { score: Parameters<typeof firstChordTarget>[0] };
    // Click the chord itself, at the exact box the engraver placed it in.
    const chord = firstChordTarget(opened.score);

    const page = await openScore(id);
    try {
      await expect.poll(() => railVersion(page)).toBe('v3');
      const sheet = page.locator('.sheet').nth(chord.pageIndex);
      const box = await sheet.boundingBox();
      if (box === null) throw new Error('no sheet box');
      await sheet.click({ position: { x: chord.cx * box.width, y: chord.cy * box.height } });
      const field = page.getByLabel('Chord symbol');
      await field.waitFor({ timeout: 5_000 });
      await expect.poll(() => field.inputValue()).toBe('Cmaj7');

      await field.fill('Ab/Eb');
      await page.getByRole('button', { name: 'Save' }).click();
      await expect.poll(() => railVersion(page)).toBe('v4');

      const shown = stack.cli(['show', id]) as { projection: string };
      expect(shown.projection).toContain('Ab/Eb');
      expect(shown.projection).not.toContain('Cmaj7');
    } finally {
      await page.close();
    }
  });
});
