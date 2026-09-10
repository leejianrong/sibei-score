/**
 * Capture real screenshots of the browser, for the README and the `screenshots/` gallery.
 *
 * A development entry point, not product surface. It boots the whole stack the way `pnpm demo:v4`
 * and the V4d E2E do — `sbscore serve` + `vite` + a real Chromium — authors a few charts through
 * the CLI so there is something to look at, and drives the browser to each state worth showing.
 *
 *   pnpm screenshots
 *
 * Output lands in `screenshots/` (committed, so the README can embed it). Re-run after a UI change
 * that alters any captured state; the shots are regenerable and not a snapshot test.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { DEFAULT_MUSIC_FONT } from '@sibei/engrave';
import type { Score } from '@sibei/model';
import { type Browser, chromium, type Page } from 'playwright';
import { barBoxFor, loadFont, pageBarBoxes, pageItemBoxes, renderScorePages } from '@sibei/ui';

const REPO = resolve(import.meta.dirname, '..');
const OUT = join(REPO, 'screenshots');

/** A desktop viewport wide enough for the rail and a sheet side by side. */
const VIEWPORT = { width: 1280, height: 860 };

function freePort(): Promise<number> {
  return new Promise((resolveWith, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolveWith(port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`nothing answered at ${url} within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The API prints `{"listening": "http://127.0.0.1:PORT", ...}` as its first line under --json. */
function awaitApiUrl(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolveWith, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`serve did not announce in ${timeoutMs}ms:\n${out}`)), timeoutMs);
    const onData = (chunk: Buffer): void => {
      out += chunk.toString();
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const value = JSON.parse(trimmed) as { listening?: string };
          if (typeof value.listening === 'string') {
            clearTimeout(timer);
            resolveWith(value.listening);
            return;
          }
        } catch {
          // partial line
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => reject(new Error(`serve exited (${code}) before announcing:\n${out}`)));
  });
}

function discoverChromium(): string | undefined {
  const base = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  if (base === undefined || base === '' || !existsSync(base)) return undefined;
  for (const entry of readdirSync(base)) {
    if (entry.startsWith('chromium-') && !entry.includes('headless')) {
      const chrome = join(base, entry, 'chrome-linux', 'chrome');
      if (existsSync(chrome)) return chrome;
    }
  }
  return undefined;
}

function killGroup(child: ChildProcess | undefined): void {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

/** A bar's centre, as a fraction of the sheet — the app's own bar geometry, so a click selects it. */
function barFraction(score: Score, barNumber: number): { pageIndex: number; cx: number; cy: number } | null {
  const pages = renderScorePages(score, { paper: 'a4' }, { font: DEFAULT_MUSIC_FONT });
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    if (page === undefined) continue;
    const box = barBoxFor(pageBarBoxes(page.layout), barNumber);
    if (box !== null) {
      // Left of centre, below the staff lines: clear of the notes and the chord band, so the click
      // lands on the bar rather than something in it.
      return {
        pageIndex,
        cx: (box.x + box.width * 0.3) / page.layout.width,
        cy: (box.y + box.height * 0.82) / page.layout.height,
      };
    }
  }
  return null;
}

/** The first note on a chart, as a fraction of the sheet — the app's own geometry, so a click lands. */
function firstNoteFraction(score: Score): { pageIndex: number; cx: number; cy: number } | null {
  const pages = renderScorePages(score, { paper: 'a4' }, { font: DEFAULT_MUSIC_FONT });
  const font = loadFont(DEFAULT_MUSIC_FONT);
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    if (page === undefined) continue;
    const note = pageItemBoxes(page.layout, font).find((box) => box.kind === 'note');
    if (note !== undefined) {
      return {
        pageIndex,
        cx: (note.x + note.width / 2) / page.layout.width,
        cy: (note.y + note.height / 2) / page.layout.height,
      };
    }
  }
  return null;
}

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const dataDir = join(REPO, 'out', 'screenshots-data');
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const spawnOptions = { cwd: REPO, detached: true } as const;

  const api = spawn('pnpm', ['sbscore', 'serve', '--port', '0', '--data', join(dataDir, 'scores.db'), '--json'], {
    ...spawnOptions,
    env: { ...process.env },
  });
  let vite: ChildProcess | undefined;
  let browser: Browser | undefined;

  try {
    const apiUrl = await awaitApiUrl(api, 20_000);
    const cli = (args: string[]): unknown =>
      JSON.parse(
        execFileSync('pnpm', ['sbscore', ...args, '--json'], {
          cwd: REPO,
          env: { ...process.env, SBSCORE_URL: apiUrl },
          encoding: 'utf8',
        }),
      );

    // A few charts, so the library has something to list and the score view has real music.
    cli(['new', '--id', 'body-and-soul', '--title', 'Body and Soul', '--composer', 'Johnny Green', '--key', 'Db', '--bars', '8']);
    cli(['meta', 'set', 'body-and-soul', '--style', 'Ballad']);
    const melody: [string, string, string][] = [
      ['bar1.beat1', 'Db5', '8'], ['bar1.beat1.5', 'Eb5', '8'], ['bar1.beat2', 'F5', '4'], ['bar1.beat3', 'Gb5', '2'],
      ['bar2.beat1', 'F5', '4'], ['bar2.beat2', 'Ab5', '4'], ['bar2.beat3', 'Bb5', '2'],
      ['bar3.beat1', 'C6', '4'], ['bar3.beat2', 'Bb5', '4'], ['bar3.beat3', 'Ab5', '2'],
      ['bar5.beat1', 'Eb5', '4'], ['bar5.beat2', 'F5', '4'],
    ];
    for (const [where, pitch, dur] of melody) cli(['note', 'add', 'body-and-soul', where, '--pitch', pitch, '--dur', dur]);

    // A chart with real structure, so the Structure panel (V7c) has something to select and edit:
    // a section, a repeat around the first four bars, and a 1st ending on bar 4.
    cli(['new', '--id', 'structure-demo', '--title', 'Structure', '--composer', 'sibei-score', '--key', 'C', '--bars', '8']);
    for (const [where, pitch] of [['bar1.beat1', 'E5'], ['bar2.beat1', 'G5'], ['bar3.beat1', 'C5'], ['bar4.beat1', 'D5']] as const) {
      cli(['note', 'add', 'structure-demo', where, '--pitch', pitch, '--dur', '2']);
    }
    cli(['section', 'set', 'structure-demo', 'bar1', '--letter', 'A', '--name', 'Head']);
    cli(['repeat', 'set', 'structure-demo', 'bar1', 'bar4']);
    cli(['ending', 'set', 'structure-demo', 'bar4', '--numbers', '1', '--role', 'start-stop']);

    cli(['new', '--id', 'autumn-leaves', '--title', 'Autumn Leaves', '--composer', 'Joseph Kosma', '--key', 'Gm', '--bars', '32']);
    cli(['new', '--id', 'blue-bossa', '--title', 'Blue Bossa', '--composer', 'Kenny Dorham', '--key', 'Cm', '--bars', '16']);
    cli(['new', '--id', 'take-five', '--title', 'Take Five', '--composer', 'Paul Desmond', '--key', 'Ebm', '--time', '5/4', '--bars', '8']);
    for (const [where, pitch] of [['bar1.beat1', 'Bb4'], ['bar1.beat2', 'C5'], ['bar1.beat3', 'Db5'], ['bar1.beat4', 'C5'], ['bar1.beat5', 'Bb4']] as const) {
      cli(['note', 'add', 'take-five', where, '--pitch', pitch, '--dur', '4']);
    }

    const uiPort = await freePort();
    vite = spawn(
      'pnpm',
      ['--filter', '@sibei/ui', 'exec', 'vite', '--port', String(uiPort), '--strictPort', '--host', '127.0.0.1'],
      { ...spawnOptions, env: { ...process.env, SBSCORE_API: apiUrl } },
    );
    const uiUrl = `http://127.0.0.1:${uiPort}`;
    await waitForHttp(`${uiUrl}/`, 30_000);

    const executablePath = discoverChromium();
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });

    const shoot = async (page: Page, name: string): Promise<void> => {
      await page.screenshot({ path: join(OUT, name) });
      console.log(`wrote screenshots/${name}`);
    };

    // 1. The library.
    const library = await context.newPage();
    await library.goto(`${uiUrl}/#/`, { waitUntil: 'domcontentloaded' });
    await library.waitForSelector('main');
    await library.waitForTimeout(400);
    await shoot(library, 'library.png');
    // The same view, filtering as you type.
    const filter = library.getByPlaceholder(/Filter/);
    if (await filter.count()) {
      await filter.first().fill('bossa');
      await library.waitForTimeout(300);
      await shoot(library, 'library-search.png');
    }
    await library.close();

    // 2. The score view, engraved face.
    const score = await context.newPage();
    await score.goto(`${uiUrl}/#/score/body-and-soul`, { waitUntil: 'domcontentloaded' });
    await score.waitForSelector('.sheet');
    await score.waitForTimeout(400);
    await shoot(score, 'score-view.png');

    // 3. The handwritten (jazz) face — the same chart, one control away.
    const jazz = score.getByRole('button', { name: 'jazz' });
    if (await jazz.count()) {
      await jazz.first().click();
      await score.waitForTimeout(400);
      await shoot(score, 'score-view-jazz.png');
      await score.getByRole('button', { name: 'normal' }).first().click();
      await score.waitForTimeout(300);
    }

    // 4. A note selected, the inspector open.
    const record = cli(['open', 'body-and-soul']) as { score: Score };
    const target = firstNoteFraction(record.score);
    if (target !== null) {
      const sheet = score.locator('.sheet').nth(target.pageIndex);
      const box = await sheet.boundingBox();
      if (box !== null) {
        await sheet.click({ position: { x: target.cx * box.width, y: target.cy * box.height } });
        // The inspector form lives at the bottom of the scrollable rail — bring it into view so the
        // shot shows the Pitch/Duration/Save controls, not just the selection highlight on the sheet.
        await score.getByLabel('Pitch').waitFor({ timeout: 5_000 });
        await score.getByRole('button', { name: 'Save' }).scrollIntoViewIfNeeded();
        await score.waitForTimeout(300);
        await shoot(score, 'inspector.png');
      }
    }
    await score.close();

    // 5. A bar selected, the Structure panel open (V7c).
    const structure = await context.newPage();
    await structure.goto(`${uiUrl}/#/score/structure-demo`, { waitUntil: 'domcontentloaded' });
    await structure.waitForSelector('.sheet');
    await structure.waitForTimeout(400);
    const barRecord = cli(['open', 'structure-demo']) as { score: Score };
    const barTarget = barFraction(barRecord.score, 4); // the 1st-ending / repeat-end bar
    if (barTarget !== null) {
      const sheet = structure.locator('.sheet').nth(barTarget.pageIndex);
      const box = await sheet.boundingBox();
      if (box !== null) {
        await sheet.click({ position: { x: barTarget.cx * box.width, y: barTarget.cy * box.height } });
        await structure.getByRole('button', { name: 'Save' }).waitFor({ timeout: 5_000 });
        await structure.getByRole('button', { name: 'Save' }).scrollIntoViewIfNeeded();
        await structure.waitForTimeout(300);
        await shoot(structure, 'structure-panel.png');
      }
    }
    await structure.close();

    // A chart in a different meter, so the gallery isn't all one time signature.
    const five = await context.newPage();
    await five.goto(`${uiUrl}/#/score/take-five`, { waitUntil: 'domcontentloaded' });
    await five.waitForSelector('.sheet');
    await five.waitForTimeout(400);
    await shoot(five, 'take-five.png');
    await five.close();

    console.log('done');
  } finally {
    if (browser !== undefined) await browser.close().catch(() => {});
    killGroup(vite);
    killGroup(api);
  }
}

await main();
