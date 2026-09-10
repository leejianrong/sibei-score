import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firstNoteTarget, type NoteTarget } from './support/geometry.js';
import { startStack, type Stack } from './support/stack.js';

/**
 * V4d's end-to-end tests — the ones SLICES.md's V4 test plan lists under "End-to-end", and the
 * reason V4d exists as its own card. They boot the **whole stack** (`support/stack.ts`) and drive
 * a **real** browser, because the thing under test is the seam between the surfaces — a jsdom
 * simulation would pass while the product is broken, which `agent_docs/testing.md` names as exactly
 * the failure to avoid here.
 *
 * All three turn on the one property the architecture is built to guarantee: the browser and the
 * CLI are two clients of one API (ADR-0002) and cannot disagree about a chart. A browser edit is a
 * store write the CLI then reads; a CLI edit repaints the browser through the change stream (V4a)
 * without a reload; and two browser tabs on one chart converge after an edit in either.
 *
 * The stack is booted once — it starts two subprocesses and a browser — and each test authors its
 * own chart under a distinct id, so nothing leaks between them.
 */

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 90_000);

afterAll(async () => {
  await stack?.stop();
});

/** Open a chart in a fresh page and wait for the engraving to be on the screen. */
async function openScore(id: string): Promise<Page> {
  const page = await stack.browser.newPage();
  // Not `networkidle`: the SSE stream is a request that never ends, so the network is never idle.
  await page.goto(stack.scoreUrl(id), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sheet');
  return page;
}

/**
 * The rail's version cell text (e.g. `v2`), addressed through its label so the read is not coupled
 * to the order of the facts list. Driving Playwright as a *library* under vitest, there are no
 * web-first assertions — so `expect.poll` over this is how the tests wait for a version to move.
 */
function railVersion(page: Page): Promise<string> {
  return page.locator('dt:text-is("version") + dd').textContent().then((text) => text ?? '');
}

/** Click a note on the sheet — at the fraction the app's own geometry puts it — and open it. */
async function selectNote(page: Page, target: NoteTarget): Promise<void> {
  const sheet = page.locator('.sheet').nth(target.pageIndex);
  const box = await sheet.boundingBox();
  if (box === null) throw new Error('the sheet has no box on screen');
  await sheet.click({ position: { x: target.cx * box.width, y: target.cy * box.height } });
  // The Pitch field exists only while a note is selected, so its arrival is the click landing.
  await page.getByLabel('Pitch').waitFor({ timeout: 5_000 });
}

/** Author a fresh chart with a single note at bar 1, and the geometry to click it. */
function authorOneNoteChart(id: string): NoteTarget {
  stack.cli(['new', '--id', id, '--title', 'Live', '--key', 'C', '--bars', '4']);
  stack.cli(['note', 'add', id, 'bar1.beat1', '--pitch', 'C5', '--dur', '4']);
  const opened = stack.cli(['open', id]) as { score: Parameters<typeof firstNoteTarget>[0] };
  return firstNoteTarget(opened.score);
}

describe('the browser and the CLI over a live stack', () => {
  it('carries a browser edit into the store, where the CLI reads it back', async () => {
    const id = 'e2e-browser-edit';
    const target = authorOneNoteChart(id);
    const page = await openScore(id);
    try {
      await expect.poll(() => railVersion(page)).toBe('v2');

      await selectNote(page, target);
      await page.getByLabel('Pitch').fill('A5');
      await page.getByRole('button', { name: 'Save' }).click();

      // The browser re-reads after a successful write (V4c), so its own version moves.
      await expect.poll(() => railVersion(page)).toBe('v3');

      // And the edit is in the store, which is the whole claim: `sbscore show` prints the new pitch.
      const shown = stack.cli(['show', id]) as { projection: string };
      expect(shown.projection.toLowerCase()).toContain('a5');
      expect(shown.projection.toLowerCase()).not.toContain('c5');
    } finally {
      await page.close();
    }
  });

  it('repaints an open browser when the CLI edits the chart, with no reload', async () => {
    const id = 'e2e-cli-edit';
    authorOneNoteChart(id);
    const page = await openScore(id);
    let reloads = 0;
    page.on('load', () => (reloads += 1));
    try {
      await expect.poll(() => railVersion(page)).toBe('v2');

      // An edit from the *other* surface. The browser is not touched.
      stack.cli(['note', 'set', id, 'bar1.n1', '--pitch', 'G5']);

      // The change stream (V4a) moves the open view to the new version on its own.
      await expect.poll(() => railVersion(page)).toBe('v3');
      expect(await page.locator('.sheet').count()).toBeGreaterThan(0);
      // The repaint was the stream, not a navigation: the page never loaded a second time.
      expect(reloads).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('keeps two tabs on one chart consistent after an edit in either', async () => {
    const id = 'e2e-two-tabs';
    const target = authorOneNoteChart(id);
    const tabA = await openScore(id);
    const tabB = await openScore(id);
    try {
      await expect.poll(() => railVersion(tabA)).toBe('v2');
      await expect.poll(() => railVersion(tabB)).toBe('v2');

      // Edit in tab A, through the browser's own write path.
      await selectNote(tabA, target);
      await tabA.getByLabel('Pitch').fill('F5');
      await tabA.getByRole('button', { name: 'Save' }).click();

      // Tab A moves because it saved; tab B moves because the stream told it to.
      await expect.poll(() => railVersion(tabA)).toBe('v3');
      await expect.poll(() => railVersion(tabB)).toBe('v3');

      const shown = stack.cli(['show', id]) as { projection: string };
      expect(shown.projection.toLowerCase()).toContain('f5');
    } finally {
      await tabA.close();
      await tabB.close();
    }
  });
});
