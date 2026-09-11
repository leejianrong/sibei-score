import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OMR_SCHEMA_VERSION } from '@sibei/model';
import type { OmrDocument } from '@sibei/model';
import { startStack, type Stack } from './support/stack.js';

/**
 * V11's headline path, through the whole stack: pick a photo in the library, watch the recogniser run
 * as a job (ADR-0001), and land on an editable draft (ADR-0019). A real browser, because the thing
 * under test is the library's import control reaching the same `/v1/imports` the CLI uses — the "cannot
 * disagree" property (ADR-0002) for the one write the browser gains in this slice.
 *
 * The OMR worker is faked (a canned `OmrDocument` returned over the worker HTTP seam): the real one
 * needs oemer, weights and minutes (V9), and what this test is about is the API mapping the recognised
 * objects onto a score and the browser opening it — not recognition accuracy, which is the eval
 * harness's job (V12, ADR-0020).
 */

// One staff, two notes split by a barline: a two-bar draft, enough to see land as a real chart.
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
};

/** A minimal valid PNG the upload boundary accepts (only the header is read, ADR-0029). */
function pngBytes(): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(1200, 8);
  ihdr.writeUInt32BE(400, 12);
  return Buffer.concat([sig, ihdr]);
}

let stack: Stack;

beforeAll(async () => {
  stack = await startStack({ workerDocument: CANNED });
}, 90_000);

afterAll(async () => {
  await stack?.stop();
});

async function openLibrary(): Promise<Page> {
  const page = await stack.browser.newPage();
  await page.goto(`${stack.uiUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.import-btn');
  return page;
}

describe('importing a photo from the library (V11)', () => {
  it('turns a picked image into a new draft chart and opens it', async () => {
    const page = await openLibrary();
    try {
      // Choose a file on the hidden picker directly — the visible button just proxies a click to it.
      await page.setInputFiles('.file-picker', {
        name: 'lead-sheet.png',
        mimeType: 'image/png',
        buffer: pngBytes(),
      });

      // The recogniser runs as a job; when it lands, the app navigates to the new score view. The
      // canned two-note, one-barline page maps to a two-bar draft.
      await page.waitForFunction(() => window.location.hash.startsWith('#/score/'), undefined, {
        timeout: 30_000,
      });
      await page.waitForSelector('svg', { timeout: 10_000 });

      const id = decodeURIComponent(new URL(page.url()).hash.replace('#/score/', ''));
      expect(id).toMatch(/^import-/);

      // And it is really in the store: the CLI reads the same draft back (the "cannot disagree" property).
      const opened = stack.cli(['open', id]) as { score: { bars: unknown[] } };
      expect(opened.score.bars.length).toBe(2);
    } finally {
      await page.close();
    }
  });
});
