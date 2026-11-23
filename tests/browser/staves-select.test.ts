import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Score } from '@sibei/model';
import { barTarget, laneNoteTarget, staffBarTarget, type NoteTarget } from './support/geometry.js';
import { startStack, type Stack } from './support/stack.js';

/**
 * Slice 5b end-to-end (ADR-0041): the editor selects and edits any staff and voice, not the first. A click on
 * staff 2 or on a second voice has to resolve to that lane through the layout's own `staves`, and an edit by
 * position has to go out with a qualified address. Boots the stack like its siblings; a jsdom simulation would
 * pass while the lower staff was unclickable.
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

interface Item {
  kind: string;
  pitch?: { step: string; alter: number; octave: number };
  duration?: { value: number; dots: number };
}
interface Doc {
  score: Score & {
    parts: { staves: { bars: { barId: string; voices: { index: number; items: Item[] }[] }[] }[] }[];
  };
}

/** The items of one lane in bar 1, read off the stored document: `staff` and `voice` are 1-based. */
function laneItems(id: string, staff: number, voice: number): Item[] {
  const doc = stack.cli(['open', id]) as Doc;
  const bar1 = doc.score.bars.find((bar) => bar.number === 1)!.id;
  const staves = doc.score.parts.flatMap((part) => part.staves);
  const staffBar = staves[staff - 1]!.bars.find((bar) => bar.barId === bar1)!;
  return staffBar.voices.find((v) => v.index === voice)?.items ?? [];
}

function pitchText(item: Item | undefined): string {
  if (item?.pitch === undefined) return '';
  const { step, alter, octave } = item.pitch;
  return `${step}${alter === 1 ? '#' : alter === -1 ? 'b' : ''}${octave}`;
}

/** A grand staff with a second voice on the top staff: C5 over a bass C3, and a G4 in voice 2. */
function authorGrand(id: string): Score {
  stack.cli(['new', '--id', id, '--title', 'Grand', '--key', 'C', '--bars', '4']);
  stack.cli(['staff', 'add', id, '--clef', 'bass']);
  stack.cli(['voice', 'add', id, 's1']);
  stack.cli(['note', 'add', id, 's1.v1.bar1.beat1', '--pitch', 'C5', '--dur', '4']);
  stack.cli(['note', 'add', id, 's1.v2.bar1.beat1', '--pitch', 'G4', '--dur', '4']);
  stack.cli(['note', 'add', id, 's2.v1.bar1.beat1', '--pitch', 'C3', '--dur', '4']);
  stack.cli(['rest', 'add', id, 's2.v1.bar1.beat2', '--dur', '4']);
  return (stack.cli(['open', id]) as { score: Score }).score;
}

describe('editing a second staff and a second voice in the browser (slice 5b)', () => {
  it('a click on the lower staff selects its note and saves it back into that staff', async () => {
    const id = 'e2e-staves-pitch';
    const score = authorGrand(id);
    const page = await openScore(id);
    try {
      await click(page, laneNoteTarget(score, 1));
      await page.getByLabel('Pitch').waitFor({ timeout: 5_000 });
      await expect.poll(() => page.getByTestId('active-lane').textContent()).toContain('Staff 2');
      await page.getByLabel('Pitch').fill('D3');
      await page.getByRole('button', { name: 'Save' }).click();

      await expect.poll(() => pitchText(laneItems(id, 2, 1)[0])).toBe('D3');
      // Nothing leaked into the top staff.
      expect(pitchText(laneItems(id, 1, 1)[0])).toBe('C5');
      expect(pitchText(laneItems(id, 1, 2)[0])).toBe('G4');
    } finally {
      await page.close();
    }
  });

  it('a click on the second voice selects that voice, not the first', async () => {
    const id = 'e2e-staves-voice';
    const score = authorGrand(id);
    const page = await openScore(id);
    try {
      await click(page, laneNoteTarget(score, 0, 2));
      await page.getByLabel('Pitch').waitFor({ timeout: 5_000 });
      await expect.poll(() => page.getByTestId('active-lane').textContent()).toContain('Voice 2');
      await page.getByLabel('Pitch').fill('A4');
      await page.getByRole('button', { name: 'Save' }).click();

      await expect.poll(() => pitchText(laneItems(id, 1, 2)[0])).toBe('A4');
      expect(pitchText(laneItems(id, 1, 1)[0])).toBe('C5');
    } finally {
      await page.close();
    }
  });

  it('replaces a rest on the lower staff by a qualified address', async () => {
    const id = 'e2e-staves-rest';
    const score = authorGrand(id);
    const page = await openScore(id);
    try {
      await click(page, laneNoteTarget(score, 1, 1, 'rest'));
      await page.getByRole('group', { name: 'Rest value' }).waitFor({ timeout: 5_000 });
      await page.getByRole('group', { name: 'Rest value' }).getByRole('button', { name: '2', exact: true }).click();
      await page.getByRole('button', { name: 'Save' }).click();

      await expect
        .poll(() => laneItems(id, 2, 1).find((item) => item.kind === 'rest')?.duration?.value)
        .toBe(2);
      // The top staff's items are untouched, so the rest stayed on staff 2.
      expect(laneItems(id, 1, 1).filter((item) => item.kind === 'rest')).toHaveLength(0);
    } finally {
      await page.close();
    }
  });

  it('a click on an empty bar of the lower staff makes that staff active', async () => {
    const id = 'e2e-staves-bar';
    const score = authorGrand(id);
    const page = await openScore(id);
    try {
      await click(page, staffBarTarget(score, 2, 1));
      await page.getByLabel('Rehearsal letter').waitFor({ timeout: 5_000 });
      await expect.poll(() => page.getByTestId('active-lane').textContent()).toContain('Staff 2');
    } finally {
      await page.close();
    }
  });

  it('a one-staff chart shows no lane status and its bar click is unchanged', async () => {
    const id = 'e2e-staves-single';
    stack.cli(['new', '--id', id, '--title', 'Single', '--key', 'C', '--bars', '4']);
    stack.cli(['note', 'add', id, 'bar1.beat1', '--pitch', 'C5', '--dur', '4']);
    const score = (stack.cli(['open', id]) as { score: Score }).score;
    const page = await openScore(id);
    try {
      expect(await page.getByTestId('active-lane').count()).toBe(0);
      const target = barTarget(score, 2);
      await click(page, target);
      await page.getByLabel('Rehearsal letter').waitFor({ timeout: 5_000 });
    } finally {
      await page.close();
    }
  });
});
