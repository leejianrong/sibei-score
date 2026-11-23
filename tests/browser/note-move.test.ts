import { join } from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Score } from '@sibei/model';
import { laneNoteTarget, type NoteTarget } from './support/geometry.js';
import { startStack, type Stack } from './support/stack.js';

/**
 * Moving music between hands in the browser (SIB2-244, Q79): the inspector's Move to other staff for one selected note, and
 * the Staves panel's range form. Every assertion reads the store through the CLI, so it is the document that is checked.
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

interface Pitch {
  step: string;
  alter: number;
  octave: number;
}
interface Item {
  kind: string;
  pitch?: Pitch;
  stack?: { pitch: Pitch }[];
}
interface Doc {
  score: Score & { parts: { staves: { bars: { barId: string; voices: { index: number; items: Item[] }[] }[] }[] }[] };
}

/** The pitches written in bar 1 of one staff (1-based), voice 1, low to high. */
function written(id: string, staff: number): string[] {
  const doc = stack.cli(['open', id]) as Doc;
  const bar1 = doc.score.bars.find((bar) => bar.number === 1)!.id;
  const staves = doc.score.parts.flatMap((part) => part.staves);
  const items = staves[staff - 1]!.bars.find((bar) => bar.barId === bar1)!.voices.find((v) => v.index === 1)?.items ?? [];
  const text = (p: Pitch): string => `${p.step}${p.alter === 1 ? '#' : p.alter === -1 ? 'b' : ''}${p.octave}`;
  return items.filter((item) => item.kind === 'note').flatMap((item) => [item.pitch!, ...(item.stack ?? []).map((t) => t.pitch)].map(text)).sort();
}

function piano(id: string): Score {
  stack.cli(['new', '--id', id, '--title', 'Hands', '--key', 'C', '--bars', '2']);
  stack.cli(['staff', 'add', id, 'p1', '--clef', 'bass']);
  stack.cli(['rest', 'add', id, 's2.bar1.beat1', '--dur', '1']);
  stack.cli(['note', 'add', id, 's1.bar1.beat1', '--pitch', 'E5', '--dur', '2']);
  stack.cli(['note', 'add', id, 's1.bar1.beat3', '--pitch', 'C3', '--dur', '2']);
  return (stack.cli(['open', id]) as Doc).score;
}

describe('moving notes between staves in the browser', () => {
  it('moves one selected note to the other staff from the inspector, as one op the CLI reads back', async () => {
    const id = 'e2e-move-note';
    const score = piano(id);
    const page = await openScore(id);
    try {
      expect(written(id, 1)).toEqual(['C3', 'E5']);
      await click(page, laneNoteTarget(score, 0, 1, 'note'));
      await page.getByRole('button', { name: 'Move to other staff', exact: true }).click();
      await expect.poll(() => written(id, 2), { timeout: 20_000 }).toEqual(['E5']);
      expect(written(id, 1)).toEqual(['C3']);
    } finally {
      await page.close();
    }
  }, 120_000);

  it('moves a bar range below a split point from the Staves panel', async () => {
    const id = 'e2e-move-range';
    piano(id);
    const page = await openScore(id);
    try {
      const form = page.getByRole('group', { name: 'Move notes between staves' });
      await form.getByLabel('First bar to move').fill('1');
      await form.getByLabel('Move from staff').selectOption('1');
      await form.getByLabel('Move to staff').selectOption('2');
      await form.getByLabel('Which notes to move').selectOption('below');
      await form.getByLabel('Where the split falls').fill('C4');
      await form.getByRole('button', { name: 'Move notes between staves', exact: true }).click();
      await expect.poll(() => written(id, 2), { timeout: 20_000 }).toEqual(['C3']);
      expect(written(id, 1)).toEqual(['E5']);
    } finally {
      await page.close();
    }
  }, 120_000);

  it('re-splits a piano import at another split point from the score view, into a new draft', async () => {
    const fixture = join(import.meta.dirname, '..', 'fixtures', 'note-events', 'piano-two-hands.json');
    const job = stack.cli(['import', '--note-events', fixture, '--split-point', '96']) as { scoreId: string };
    const listed = (): number => (stack.cli(['list']) as { scores: unknown[] }).scores.length;
    const before = listed();
    const page = await openScore(job.scoreId);
    try {
      const group = page.getByRole('group', { name: 'Re-split the hands' });
      await group.waitFor({ timeout: 10_000 });
      await group.getByLabel('Split point for the hands').fill('G2');
      await group.getByRole('button', { name: 'Re-split hands', exact: true }).click();
      await expect.poll(listed, { timeout: 30_000 }).toBe(before + 1);
      await page.waitForFunction((old) => !window.location.hash.includes(old), job.scoreId, { timeout: 30_000 });
    } finally {
      await page.close();
    }
  }, 120_000);
});
