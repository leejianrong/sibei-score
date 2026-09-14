import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OMR_SCHEMA_VERSION } from '@sibei/model';
import type { OmrDocument } from '@sibei/model';
import { startStack, type Stack } from './support/stack.js';

/**
 * V14b's headline path, through the whole stack: open a chart that came from an import and see its
 * retained scan beside the engraved score (ADR-0019 — every parse is a draft, and correction is
 * side-by-side). A real browser, because the thing under test is the review layout the score view
 * grows and the `/v1/scores/:id/source` → `/v1/imports/:jobId/images/:index` seam the browser walks
 * to reach the scan; and the contrast case — a hand-authored chart shows no pane and no error — which
 * only a rendered view can prove.
 *
 * The OMR worker is faked over the HTTP seam (the same canned `OmrDocument` V11's test uses): the
 * scan bytes shown come straight from what the upload stored (the review pane draws the uploaded
 * PNG), so recognition accuracy is irrelevant here — the pane is a picture viewer over the retained
 * source, not a second opinion about the notation.
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
    { id: 1, bbox: [691, 120, 709, 136], track: 0, group: 0, noteGroupId: null, staffLinePos: null, pitch: null, hasDot: false, stemUp: true, invalid: false, label: 'HALF' },
  ],
  noteGroups: [],
  barlines: [{ bbox: [500, 100, 501, 164], group: 0 }],
  rests: [],
  bandTokens: [],
};

/**
 * A *complete*, decodable 1×1 PNG — not the header-only stub the other import tests use. The review
 * pane draws this exact uploaded blob as an `<img>` and a real browser must actually render it, so the
 * bytes have to decode; a header without pixel data would leave the image broken and prove nothing
 * about the pane. The upload boundary accepts it (a positive dimension under the caps, ADR-0029).
 */
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

describe('the split-pane review (V14b)', () => {
  it('shows the retained scan beside the score, and the toggle hides and restores it', async () => {
    const { page } = await importAndOpen();
    try {
      // The scan pane is shown by default for an imported chart (ADR-0019: side-by-side is the point),
      // and the retained source really renders — the uploaded PNG decodes, so the `<img>` is visible.
      const scan = page.locator('.source-pane img.scan');
      await scan.waitFor({ state: 'visible', timeout: 10_000 });
      // It draws the retained source through the V14a image route — page 0 of this import's job.
      const src = await scan.getAttribute('src');
      expect(src).toMatch(/\/v1\/imports\/.+\/images\/0$/);

      // The two panes are a real split: both the scan and the engraved sheet are on screen at once.
      expect(await page.locator('.workspace.split').count()).toBe(1);
      expect(await page.locator('.stage svg').count()).toBeGreaterThan(0);

      // Hiding the scan collapses the split to the sheet alone; showing it brings the scan back.
      await page.click('.scan-toggle');
      await page.waitForSelector('.source-pane', { state: 'detached', timeout: 10_000 });
      expect(await page.locator('.workspace.split').count()).toBe(0);
      await page.click('.scan-toggle');
      await scan.waitFor({ state: 'visible', timeout: 10_000 });
    } finally {
      await page.close();
    }
  });

  it('shows no scan pane for a hand-authored chart, and does not error the view', async () => {
    // A chart made with the CLI has no import behind it: `GET …/source` answers the empty shape, so
    // the score view opens exactly as before — no pane, no toggle, no failure (the contrast ADR-0019
    // draws between an imported draft and an ordinary chart).
    const created = stack.cli(['new', '--title', 'By Hand', '--bars', '4']) as { scoreId: string };
    const page = await stack.browser.newPage();
    try {
      await page.goto(stack.scoreUrl(created.scoreId), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('svg', { timeout: 10_000 });
      expect(await page.locator('.source-pane').count()).toBe(0);
      expect(await page.locator('.scan-toggle').count()).toBe(0);
      // The failure surface never appears — the chart opened normally.
      expect(await page.locator('.failure').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
});
