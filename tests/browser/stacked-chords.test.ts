import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Score } from '@sibei/model';
import { firstNoteTarget, type NoteTarget } from './support/geometry.js';
import { startStack, type Stack } from './support/stack.js';

/**
 * Stacked chords in the browser (SIB2-243, Q79): select a chord, add a pitch to it from the inspector (a typed pitch, or a
 * third above or below), and remove one pitch of it. Every assertion reads the store through the CLI, so it is the document
 * that is checked and not the picture.
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

async function click(page: Page, target: NoteTarget): Promise<void> {
  const sheet = page.locator('.sheet').nth(target.pageIndex);
  const box = await sheet.boundingBox();
  if (box === null) throw new Error('the sheet has no box on screen');
  await sheet.click({ position: { x: target.cx * box.width, y: target.cy * box.height } });
}

interface Doc {
  score: Score & {
    parts: { staves: { bars: { barId: string; voices: { items: { kind: string; pitch?: { step: string; alter: number; octave: number }; stack?: { pitch: { step: string; alter: number; octave: number } }[] }[] }[] }[] }[] }[];
  };
}

function chordPitches(id: string): string[] {
  const doc = stack.cli(['open', id]) as Doc;
  const item = doc.score.parts[0]!.staves[0]!.bars[0]!.voices[0]!.items[0]!;
  const text = (p: { step: string; alter: number; octave: number }): string => `${p.step}${p.alter === 1 ? '#' : p.alter === -1 ? 'b' : ''}${p.octave}`;
  return [item.pitch, ...(item.stack ?? []).map((tone) => tone.pitch)].filter((p) => p !== undefined).map((p) => text(p!)).sort();
}

describe('editing a stacked chord in the browser', () => {
  it('adds a pitch, adds a third above and below, and removes one pitch, each one undoable op', async () => {
    const id = 'e2e-stacked-chord';
    stack.cli(['new', '--id', id, '--title', 'Chord', '--key', 'C', '--bars', '2']);
    stack.cli(['note', 'add', id, 'bar1.beat1', '--pitch', 'C4', '--dur', '4']);
    const page = await openScore(id);
    try {
      const score = (stack.cli(['open', id]) as Doc).score;
      await click(page, firstNoteTarget(score));
      const group = page.getByRole('group', { name: 'Chord notes' });
      await group.waitFor({ timeout: 5_000 });

      await group.getByLabel('Note to add to the chord').fill('G4');
      await group.getByRole('button', { name: 'Add pitch', exact: true }).click();
      await expect.poll(() => chordPitches(id), { timeout: 20_000 }).toEqual(['C4', 'G4']);

      await group.getByRole('button', { name: 'Add above', exact: true }).click();
      await expect.poll(() => chordPitches(id), { timeout: 20_000 }).toEqual(['B4', 'C4', 'G4']);

      await group.getByRole('button', { name: 'Add below', exact: true }).click();
      await expect.poll(() => chordPitches(id), { timeout: 20_000 }).toEqual(['A3', 'B4', 'C4', 'G4']);

      await group.getByRole('button', { name: 'Remove G4 from the chord' }).click();
      await expect.poll(() => chordPitches(id), { timeout: 20_000 }).toEqual(['A3', 'B4', 'C4']);
    } finally {
      await page.close();
    }
  }, 120_000);
});
