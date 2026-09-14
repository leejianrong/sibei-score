import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OMR_SCHEMA_VERSION } from '@sibei/model';
import type { OmrDocument } from '@sibei/model';
import { startStack, type Stack } from './support/stack.js';

/**
 * V14e's Re-parse control, through the whole stack: open a chart that came from an import and re-run
 * OMR on its retained scans into a NEW draft (ADR-0019 — every parse is a draft; a re-parse gives a
 * fresh one without discarding the chart on screen). A real browser, because the thing under test is
 * the control the score view shows only for a source-bearing chart and the navigation to the new draft
 * it triggers — and the contrast case, a hand-authored chart with no Re-parse control, which only a
 * rendered view can prove.
 *
 * The OMR worker is faked over the HTTP seam with the same canned `OmrDocument` V11/V14b use: a
 * re-parse takes the identical runner → `Applier.import` path a normal import does, so the faked worker
 * simply produces a second draft — recognition accuracy is irrelevant to the control and the navigation.
 */

const CANNED: OmrDocument = {
  schemaVersion: OMR_SCHEMA_VERSION,
  source: {
    engine: 'oemer',
    engineVersion: '0.1.8',
    imagePath: 'page-1',
    imageWidth: 1200,
    imageHeight: 400,
    provider: 'CPUExecutionProvider',
    wallClockSeconds: 1,
  },
  staves: [
    { index: 0, track: 0, group: 0, xLeft: 100, xRight: 1000, yUpper: 100, yLower: 164, yCenter: 132, unitSize: 16 },
  ],
  zones: [],
  noteheads: [
    { id: 0, bbox: [291, 120, 309, 136], track: 0, group: 0, noteGroupId: null, staffLinePos: null, pitch: null, hasDot: false, stemUp: true, invalid: false, label: 'HALF' },
  ],
  noteGroups: [],
  barlines: [],
  rests: [],
  bandTokens: [],
};

/** A complete, decodable 1×1 PNG the upload boundary accepts (see source-pane.test.ts for why). */
function pngBytes(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
}

let stack: Stack;

beforeAll(async () => {
  stack = await startStack({ workerDocument: CANNED });
}, 90_000);

afterAll(async () => {
  await stack?.stop();
});

/** Import a photo from the library and wait for the app to land on the new draft's score view. */
async function importAndOpen(): Promise<{ page: Page; id: string }> {
  const page = await stack.browser.newPage();
  await page.goto(`${stack.uiUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.import-btn');
  await page.setInputFiles('.file-picker', { name: 'lead-sheet.png', mimeType: 'image/png', buffer: pngBytes() });
  await page.waitForFunction(() => window.location.hash.startsWith('#/score/'), undefined, { timeout: 30_000 });
  await page.waitForSelector('svg', { timeout: 10_000 });
  const id = decodeURIComponent(new URL(page.url()).hash.replace('#/score/', ''));
  return { page, id };
}

describe('the Re-parse control (V14e)', () => {
  it('shows the control for an imported chart and opens a NEW draft on re-parse', async () => {
    const { page, id } = await importAndOpen();
    try {
      // The control appears only for a source-bearing chart — the same gate the scan toggle uses.
      const button = page.locator('.reparse-btn');
      await button.waitFor({ state: 'visible', timeout: 10_000 });
      expect(await page.locator('.reparse-engine').count()).toBe(1);

      // Pick a non-default engine, then re-parse. The app navigates to the new draft, whose id differs
      // from the one on screen — the original is not replaced in place.
      await page.selectOption('.reparse-engine', 'heuristic');
      await button.click();
      await page.waitForFunction(
        (previous) => window.location.hash.startsWith('#/score/') && !window.location.hash.endsWith(`/${previous}`),
        id,
        { timeout: 30_000 },
      );
      await page.waitForSelector('.stage svg', { timeout: 10_000 });
      const newId = decodeURIComponent(new URL(page.url()).hash.replace('#/score/', ''));
      expect(newId).not.toBe(id);
    } finally {
      await page.close();
    }
  });

  it('shows no Re-parse control for a hand-authored chart', async () => {
    const created = stack.cli(['new', '--title', 'By Hand', '--bars', '4']) as { scoreId: string };
    const page = await stack.browser.newPage();
    try {
      await page.goto(stack.scoreUrl(created.scoreId), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('svg', { timeout: 10_000 });
      expect(await page.locator('.reparse').count()).toBe(0);
      expect(await page.locator('.reparse-btn').count()).toBe(0);
      expect(await page.locator('.failure').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
});
