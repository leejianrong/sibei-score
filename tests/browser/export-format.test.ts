import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './support/stack.js';

/**
 * The export-format toggle in the score-view rail (V8e). A real browser, because the point is that
 * pressing the segment changes the file the rail would download — the export `<a>`'s href — which is
 * the "the page you see and the file you get are one choice" the rail is built on.
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

describe('the export format toggle (V8e)', () => {
  it('switches the export link between PDF and MusicXML', async () => {
    stack.cli(['new', '--id', 'fmt', '--title', 'Format', '--key', 'C', '--bars', '4']);
    stack.cli(['note', 'add', 'fmt', 'bar1.beat1', '--pitch', 'C5', '--dur', '4']);
    const page = await openScore('fmt');
    try {
      const exportLink = page.locator('a.export');
      // PDF by default.
      await expect.poll(() => exportLink.getAttribute('href')).toContain('format=pdf');

      // Press MusicXML in the Export group's format control.
      const formats = page.getByRole('group', { name: 'Export format' });
      await formats.getByRole('button', { name: 'MusicXML' }).click();

      await expect.poll(() => exportLink.getAttribute('href')).toContain('format=musicxml');
      expect(await exportLink.getAttribute('href')).not.toContain('format=pdf');
      // The label follows the format, and the codec note appears.
      expect((await exportLink.textContent())?.trim()).toBe('Export MusicXML');
      await expect.poll(() => page.locator('.control-note', { hasText: 'MusicXML is a codec' }).count()).toBe(1);

      // And the downloaded bytes really are MusicXML — the href resolves to the codec's output.
      const href = await exportLink.getAttribute('href');
      const response = await page.request.get(`${stack.uiUrl}${href}`);
      expect(response.headers()['content-type']).toContain('musicxml');
      expect((await response.text()).startsWith('<?xml')).toBe(true);
    } finally {
      await page.close();
    }
  });
});
