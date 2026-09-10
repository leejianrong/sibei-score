import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firstNoteTarget } from './support/geometry.js';
import { startStack, type Stack } from './support/stack.js';

/**
 * V6e end-to-end: the browser controls for transpose, spelling pins, and instrument parts, over the
 * real stack (SLICES.md V6). The same "two clients of one API cannot disagree" property V4d proved
 * for notes and V5e for chords — now for the V6 capabilities. A jsdom simulation would pass while
 * the product is broken, so this boots `serve` + `vite` + a real Chromium like its siblings.
 */

interface Doc {
  score: {
    meta: { key: { tonic: string; alter: number; mode: string } };
    bars: { number: number; items: { kind: string; pitch?: { step: string; alter: number; octave: number }; spellingPinned?: boolean }[] }[];
  };
}

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
  return page.locator('dt:text-is("version") + dd').textContent().then((t) => t ?? '');
}
function railKey(page: Page): Promise<string> {
  return page.locator('dt:text-is("key") + dd').textContent().then((t) => t ?? '');
}

async function clickNote(page: Page, cx: number, cy: number): Promise<void> {
  const sheet = page.locator('.sheet').first();
  const box = await sheet.boundingBox();
  if (box === null) throw new Error('the sheet has no box on screen');
  await sheet.click({ position: { x: cx * box.width, y: cy * box.height } });
}

/** A short chart in C: a note whose transposition is easy to read (G4 -> Bb4 up a minor third). */
function authorChart(id: string): void {
  stack.cli(['new', '--id', id, '--title', 'Parts', '--key', 'C', '--bars', '4']);
  stack.cli(['note', 'add', id, 'bar1.beat1', '--pitch', 'G4', '--dur', '4']);
  stack.cli(['chord', 'set', id, 'bar1.beat1', '--text', 'C7']);
}

describe('the V6 browser controls, over a live stack (V6e)', () => {
  it('transposes the chart from the rail; the CLI reads the new key and the moved melody', async () => {
    const id = 'e2e-transpose';
    authorChart(id);
    const page = await openScore(id);
    try {
      await expect.poll(() => railVersion(page)).toBe('v3');

      await page.getByLabel('Transpose to key').selectOption({ label: 'E♭ major' });
      await page.getByRole('button', { name: 'Transpose' }).click();

      // The browser re-reads after the write, so the version moves and the rail shows the new key.
      await expect.poll(() => railVersion(page)).toBe('v4');
      await expect.poll(() => railKey(page)).toContain('E♭');

      // The store agrees: the key is Eb and G4 became Bb4 — a flat, never A#.
      const doc = stack.cli(['open', id]) as Doc;
      expect(doc.score.meta.key).toEqual({ tonic: 'E', alter: -1, mode: 'major' });
      const note = doc.score.bars.find((b) => b.number === 1)!.items.find((i) => i.kind === 'note')!;
      expect(note.pitch).toEqual({ step: 'B', alter: -1, octave: 4 });
    } finally {
      await page.close();
    }
  });

  it('pins a note spelling from the inspector; the CLI reads the pin', async () => {
    const id = 'e2e-pin';
    authorChart(id);
    const opened = stack.cli(['open', id]) as { score: Parameters<typeof firstNoteTarget>[0] };
    const target = firstNoteTarget(opened.score);

    const page = await openScore(id);
    try {
      await expect.poll(() => railVersion(page)).toBe('v3');

      await clickNote(page, target.cx, target.cy);
      await page.getByLabel('Pitch').waitFor({ timeout: 5_000 });
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Save' }).click();

      await expect.poll(() => railVersion(page)).toBe('v4');

      const doc = stack.cli(['open', id]) as Doc;
      const note = doc.score.bars.find((b) => b.number === 1)!.items.find((i) => i.kind === 'note')!;
      expect(note.spellingPinned).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('previews an instrument part and offers it for export, leaving the stored score alone', async () => {
    const id = 'e2e-part';
    authorChart(id);
    const page = await openScore(id);
    try {
      await expect.poll(() => railVersion(page)).toBe('v3');

      await page.getByLabel('Instrument part').selectOption('bb-tenor');

      // The stage names the part and the export link carries the instrument.
      await expect.poll(() => page.locator('.part-flag').textContent()).toBe('B♭ Tenor part');
      const href = await page.locator('a.export').getAttribute('href');
      expect(href).toContain('instrument=bb-tenor');
      // A part is a preview, not the truth: the rail still says the concert key (C, no flat).
      expect(await railKey(page)).not.toContain('♭');

      // The stored score is unchanged by viewing a part (ADR-0016): still in C, still version 3.
      const doc = stack.cli(['open', id]) as Doc;
      expect(doc.score.meta.key).toEqual({ tonic: 'C', alter: 0, mode: 'major' });
      await expect.poll(() => railVersion(page)).toBe('v3');
    } finally {
      await page.close();
    }
  });
});
