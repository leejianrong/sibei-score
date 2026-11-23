import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Score } from '@sibei/model';
import { staffBarTarget, type NoteTarget } from './support/geometry.js';
import { startStack, type Stack } from './support/stack.js';

/**
 * Slice 5b end-to-end, the write half: the browser adds a staff and a voice, puts the first notes into them, picks the
 * voice from the keyboard, refuses to drop music without a confirm, sets a clef and an instrument, and ctrl-Z takes a
 * shape change back. Every assertion reads the store through the CLI, so it is the document that is checked and not
 * the picture.
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
}
interface Doc {
  score: Score & {
    parts: {
      name: string;
      instrument: number | null;
      transposition: number;
      staves: { clef: string; bars: { barId: string; clef?: string; voices: { index: number; items: Item[] }[] }[] }[];
    }[];
  };
}

function read(id: string): Doc {
  return stack.cli(['open', id]) as Doc;
}

function staves(id: string): Doc['score']['parts'][number]['staves'] {
  return read(id).score.parts.flatMap((part) => part.staves);
}

function laneItems(id: string, staff: number, voice: number): Item[] {
  const doc = read(id);
  const bar1 = doc.score.bars.find((bar) => bar.number === 1)!.id;
  const staffBar = staves(id)[staff - 1]!.bars.find((bar) => bar.barId === bar1)!;
  return staffBar.voices.find((v) => v.index === voice)?.items ?? [];
}

function pitchText(item: Item | undefined): string {
  if (item?.pitch === undefined) return '';
  const { step, alter, octave } = item.pitch;
  return `${step}${alter === 1 ? '#' : alter === -1 ? 'b' : ''}${octave}`;
}

function newChart(id: string): Score {
  stack.cli(['new', '--id', id, '--title', 'Staves', '--key', 'C', '--bars', '4']);
  stack.cli(['note', 'add', id, 'bar1.beat1', '--pitch', 'C5', '--dur', '4']);
  return read(id).score;
}

describe('adding and removing staves and voices in the browser (slice 5b)', () => {
  it('adds a staff, then a first note on it from the bar panel, and the CLI reads both', async () => {
    const id = 'e2e-staves-new';
    newChart(id);
    const page = await openScore(id);
    try {
      await page.getByRole('combobox', { name: 'Clef for a new staff' }).selectOption('bass');
      await page.getByRole('button', { name: 'New staff', exact: true }).click();
      await expect.poll(() => staves(id).length).toBe(2);
      expect(staves(id)[1]!.clef).toBe('bass');
      // The new staff is the active one.
      await expect.poll(() => page.getByTestId('active-lane').textContent()).toContain('Staff 2');

      // Click the new staff's empty bar 2, then put a note in it.
      const score = read(id).score;
      await page.waitForSelector('.sheet');
      await click(page, staffBarTarget(score, 2, 1));
      await page.getByLabel('Name of the new note').waitFor({ timeout: 5_000 });
      await page.getByLabel('Name of the new note').fill('E3');
      await page.getByRole('button', { name: 'New note', exact: true }).click();

      const bar2 = score.bars.find((bar) => bar.number === 2)!.id;
      await expect
        .poll(() => {
          const lower = staves(id)[1]!.bars.find((bar) => bar.barId === bar2)!;
          return pitchText(lower.voices[0]!.items[0]);
        })
        .toBe('E3');
      // And the top staff's bar 2 stayed empty.
      const upper = staves(id)[0]!.bars.find((bar) => bar.barId === bar2)!;
      expect(upper.voices[0]!.items).toHaveLength(0);
    } finally {
      await page.close();
    }
  });

  it('adds a voice, picks it with the key 2, and a new note lands in voice 2', async () => {
    const id = 'e2e-staves-voice-add';
    newChart(id);
    const page = await openScore(id);
    try {
      await page.getByRole('button', { name: 'New voice', exact: true }).click();
      await expect.poll(() => read(id).score.parts[0]!.staves[0]!.bars[0]!.voices.length).toBe(2);
      // The lane status appears once the chart has two voices, on the new voice.
      await expect.poll(() => page.getByTestId('active-lane').textContent()).toContain('Voice 2');

      // Back to voice 1 and then to voice 2 by key.
      await page.getByRole('button', { name: 'Voice 1 of staff 1' }).click();
      await expect.poll(() => page.getByTestId('active-lane').textContent()).toContain('Voice 1');
      await page.locator('body').click({ position: { x: 2, y: 2 } });
      await page.keyboard.press('2');
      await expect.poll(() => page.getByTestId('active-lane').textContent()).toContain('Voice 2');

      const score = read(id).score;
      await click(page, staffBarTarget(score, 2, 0));
      await page.getByLabel('Name of the new note').waitFor({ timeout: 5_000 });
      await page.getByLabel('Name of the new note').fill('G4');
      await page.getByRole('button', { name: 'New note', exact: true }).click();

      const bar2 = score.bars.find((bar) => bar.number === 2)!.id;
      await expect
        .poll(() => {
          const staffBar = staves(id)[0]!.bars.find((bar) => bar.barId === bar2)!;
          return pitchText(staffBar.voices.find((v) => v.index === 2)?.items[0]);
        })
        .toBe('G4');
      const staffBar = staves(id)[0]!.bars.find((bar) => bar.barId === bar2)!;
      expect(staffBar.voices.find((v) => v.index === 1)!.items).toHaveLength(0);
    } finally {
      await page.close();
    }
  });

  it('asks before removing a staff that holds notes, removes it only on the explicit confirm, and ctrl-Z brings it back', async () => {
    const id = 'e2e-staves-remove';
    newChart(id);
    stack.cli(['staff', 'add', id, '--clef', 'bass']);
    stack.cli(['note', 'add', id, 's2.bar1.beat1', '--pitch', 'C3', '--dur', '4']);
    const page = await openScore(id);
    try {
      await page.getByRole('button', { name: 'Remove staff 2' }).click();
      // Nothing was sent: the row explains and offers the forced removal.
      await page.getByText('Remove its notes first, or remove it with its music.').waitFor({ state: 'visible', timeout: 5_000 });
      expect(staves(id)).toHaveLength(2);

      await page.getByRole('button', { name: 'Leave it' }).click();
      await expect.poll(() => page.getByText('Remove its notes first, or remove it with its music.').count()).toBe(0);
      expect(staves(id)).toHaveLength(2);

      await page.getByRole('button', { name: 'Remove staff 2' }).click();
      await page.getByRole('button', { name: 'Remove with its music' }).click();
      await expect.poll(() => staves(id).length).toBe(1);

      // ctrl-Z replays the log without the removal: the staff and its note are back.
      await page.locator('body').click({ position: { x: 2, y: 2 } });
      await page.keyboard.press('Control+z');
      await expect.poll(() => staves(id).length).toBe(2);
      expect(pitchText(laneItems(id, 2, 1)[0])).toBe('C3');
    } finally {
      await page.close();
    }
  });

  it('sets a staff clef and a part instrument from the panel', async () => {
    const id = 'e2e-staves-clef';
    newChart(id);
    const page = await openScore(id);
    try {
      await page.getByRole('combobox', { name: 'Opening clef of staff 1' }).selectOption('alto');
      await expect.poll(() => staves(id)[0]!.clef).toBe('alto');

      await page.getByLabel('Name of part 1').fill('Piano');
      await page.getByLabel('MIDI program of part 1').fill('0');
      await page.getByLabel('Semitone shift of part 1').fill('-2');
      await page.getByRole('button', { name: 'Set instrument', exact: true }).click();
      await expect.poll(() => read(id).score.parts[0]!.name).toBe('Piano');
      expect(read(id).score.parts[0]).toMatchObject({ instrument: 0, transposition: -2 });
    } finally {
      await page.close();
    }
  });

  it('a one-staff chart keeps its lead-sheet controls: no lane status, and the key 2 is not bound', async () => {
    const id = 'e2e-staves-lead';
    newChart(id);
    const page = await openScore(id);
    try {
      await page.keyboard.press('2');
      expect(await page.getByTestId('active-lane').count()).toBe(0);
      expect(await page.locator('.sheet').count()).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });
});
