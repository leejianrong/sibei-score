import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/stack.js';

/**
 * SIB2-270: a chart can be started from the browser. The empty library offers a New chart form that
 * sends `score.create`, and a sample chart opens in one click; the CLI reads back what the browser made
 * (Q79: `score.create` now has both surfaces).
 */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 90_000);

afterAll(async () => {
  await stack?.stop();
});

describe('starting a chart in the browser (SIB2-270)', () => {
  it('creates a chart from the empty library and opens it; the CLI sees the same chart', async () => {
    const page = await stack.browser.newPage();
    try {
      await page.goto(`${stack.uiUrl}/`, { waitUntil: 'domcontentloaded' });
      const form = page.getByRole('form', { name: 'New chart' });
      await form.waitFor();
      await form.getByLabel('Title').fill('Blue Monk');
      await form.getByLabel('Key').selectOption('Bb');
      await form.getByLabel('Time').selectOption('3/4');
      await form.getByLabel('Bars').fill('8');
      await form.getByRole('button', { name: 'Create chart' }).click();
      await page.waitForURL(/#\/score\//);

      const { scores } = stack.cli(['list']) as { scores: { id: string; title: string; key: string }[] };
      const made = scores.find((score) => score.title === 'Blue Monk');
      expect(made?.key).toBe('Bb');
      expect(made?.id).toMatch(/^blue-monk-/);
      const opened = stack.cli(['open', made!.id]) as { score: { meta: { time: { beats: number } }; bars: unknown[] } };
      expect(opened.score.meta.time.beats).toBe(3);
      expect(opened.score.bars).toHaveLength(8);
    } finally {
      await page.close();
    }
  });

  it('opens a sample chart in one click, with chords on it', async () => {
    const page = await stack.browser.newPage();
    try {
      await page.goto(`${stack.uiUrl}/`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'New chart' }).click();
      await page.getByRole('button', { name: 'open a sample chart' }).click();
      await page.waitForURL(/#\/score\//);
      const { scores } = stack.cli(['list']) as { scores: { id: string; title: string }[] };
      const sample = scores.find((score) => score.title === 'Sample blues in F');
      expect(sample).toBeDefined();
      const shown = stack.cli(['open', sample!.id]) as { score: { bars: unknown[] } };
      expect(shown.score.bars).toHaveLength(12);
    } finally {
      await page.close();
    }
  });

  it('starts a band from the instrument picker; the CLI reads back its parts (SIB2-288)', async () => {
    const page = await stack.browser.newPage();
    try {
      await page.goto(`${stack.uiUrl}/`, { waitUntil: 'domcontentloaded' });
      // Earlier tests left charts behind, so the form is closed until asked for.
      await page.getByRole('button', { name: 'New chart' }).click();
      const form = page.getByRole('form', { name: 'New chart' });
      await form.waitFor();
      await form.getByLabel('Title').fill('Band Setup');
      await form.getByRole('button', { name: 'Choose instruments' }).click();
      await form.getByRole('button', { name: 'Another instrument' }).click();
      await form.getByLabel('Instrument preset 1').selectOption('trumpet-bb');
      await form.getByLabel('Instrument preset 2').selectOption('drums');
      await form.getByRole('button', { name: 'Move row 2 up' }).click();
      await form.getByRole('button', { name: 'Create chart' }).click();
      await page.waitForURL(/#\/score\//);

      const { scores } = stack.cli(['list']) as { scores: { id: string; title: string }[] };
      const made = scores.find((score) => score.title === 'Band Setup');
      const opened = stack.cli(['open', made!.id]) as {
        score: { parts: { name: string; transposition: number }[]; meta: { layout?: string; showInstrumentNames?: boolean } };
      };
      expect(opened.score.parts.map((part) => [part.name, part.transposition])).toEqual([['Drum Kit', 0], ['Trumpet in Bb', 2]]);
      expect(opened.score.meta).toMatchObject({ layout: 'score', showInstrumentNames: true });
      // The names are on the page the browser draws.
      await page.locator('text.se-instrument-name').first().waitFor();
    } finally {
      await page.close();
    }
  });
});
