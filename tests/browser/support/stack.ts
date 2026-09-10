import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Browser, chromium } from 'playwright';

/**
 * Booting the whole stack for the V4d end-to-end tests (SLICES.md V4, "E2E that boots the stack").
 *
 * This is the one test harness that is not a unit of anything — it starts the **real** pieces a
 * user runs and drives them through a **real** browser:
 *
 *   `sbscore serve`  →  the API + SQLite + the change bus, exactly as `pnpm serve` starts it
 *   `vite`           →  the dev server that proxies `/v1` and serves the Svelte app
 *   chromium         →  a real browser, because a jsdom simulation would pass while the product is
 *                       broken (CLAUDE.md is explicit about this — the three tests here genuinely
 *                       need a browser, which is why V4d chose Playwright over a fake)
 *
 * It lives in the **infra** layer (`vitest.config.ts`), not a seventh CI job — the layer already
 * needs the native binding and a listening socket, and a comment in that config has reserved this
 * spot since V2a. Nothing here is subtle logic; the subtlety is all in keeping the two subprocesses
 * from outliving the test, which is why every child is spawned into its own process group and the
 * group is killed on teardown.
 */

/** The repo root, from this file at `tests/browser/support/`. */
const REPO = resolve(import.meta.dirname, '../../..');

/**
 * The pre-installed Chromium, when there is one.
 *
 * The managed environment ships a browser under `PLAYWRIGHT_BROWSERS_PATH` and asks us not to
 * download another; CI installs its own with `playwright install`, which `chromium.launch()` then
 * finds on its own. So: use the discovered binary when it exists, and otherwise let Playwright
 * resolve its default. Discovery, not a hardcoded revision, so a browser bump does not edit a path
 * in here.
 */
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

/** A short line off a child's stdout that parses as the JSON we are waiting for, or nothing yet. */
function firstJsonLine<T>(buffer: string, accept: (value: unknown) => value is T): T | undefined {
  for (const line of buffer.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (accept(value)) return value;
    } catch {
      // A partial line; keep waiting for the rest of it.
    }
  }
  return undefined;
}

function isServeAnnouncement(value: unknown): value is { listening: string } {
  return typeof value === 'object' && value !== null && typeof (value as { listening?: unknown }).listening === 'string';
}

/** Resolve when the child prints the JSON we want, reject if it dies or takes too long first. */
function waitForAnnouncement(child: ChildProcess, label: string, timeoutMs: number): Promise<{ listening: string }> {
  return new Promise((resolveWith, reject) => {
    let out = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`${label} did not announce a port in ${timeoutMs}ms:\n${out}`))), timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const announced = firstJsonLine(out, isServeAnnouncement);
      if (announced !== undefined) finish(() => resolveWith(announced));
    });
    child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.once('exit', (code) => finish(() => reject(new Error(`${label} exited (${code}) before announcing:\n${out}`))));
  });
}

/**
 * A free port to hand the dev server. Vite ignores `--port 0` (it falls back to the config's
 * fixed port and then two test files collide under `strictPort`), so we pick a concrete one — and
 * the API, which *does* honour `--port 0`, keeps announcing its own.
 */
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

/** Poll a URL until it answers, so we do not navigate before the dev server can serve. */
async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error(`nothing answered at ${url} within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Kill a child and everything it spawned, by its process group. */
function killGroup(child: ChildProcess | undefined): void {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

export interface Stack {
  /** The API base, e.g. `http://127.0.0.1:53211`. */
  readonly apiUrl: string;
  /** The dev server the browser talks to, same-origin with `/v1` proxied to the API. */
  readonly uiUrl: string;
  readonly browser: Browser;
  /** Run an `sbscore` verb against this stack's server, returning parsed `--json` output. */
  cli(args: string[]): unknown;
  /** The `#/score/:id` URL for a chart in this stack. */
  scoreUrl(id: string): string;
  stop(): Promise<void>;
}

/**
 * Start the API, the dev server and a browser, and hand back the handles plus a teardown.
 *
 * The API comes up on an OS-assigned port and *announces* it (`serve --port 0 --json`), which is
 * the reliable way to learn it; the dev server is then pointed at that URL through `SBSCORE_API`,
 * exactly the override `vite.config.ts` documents, and comes up on its own free port.
 */
export async function startStack(): Promise<Stack> {
  const dataDir = mkdtempSync(join(tmpdir(), 'sibei-e2e-'));
  // `--data` names the SQLite *file*, not a directory (the blob cache lands beside it). Both sit
  // inside the throwaway directory, which teardown removes whole.
  const dataFile = join(dataDir, 'scores.db');
  const spawnOptions = { cwd: REPO, detached: true } as const;

  const api = spawn('pnpm', ['sbscore', 'serve', '--port', '0', '--data', dataFile, '--json'], {
    ...spawnOptions,
    env: { ...process.env },
  });
  let vite: ChildProcess | undefined;
  let browser: Browser | undefined;

  const teardown = async (): Promise<void> => {
    if (browser !== undefined) await browser.close().catch(() => {});
    killGroup(vite);
    killGroup(api);
    rmSync(dataDir, { recursive: true, force: true });
  };

  try {
    const { listening: apiUrl } = await waitForAnnouncement(api, 'sbscore serve', 20_000);

    const uiPort = await freePort();
    vite = spawn(
      'pnpm',
      ['--filter', '@sibei/ui', 'exec', 'vite', '--port', String(uiPort), '--strictPort', '--host', '127.0.0.1'],
      { ...spawnOptions, env: { ...process.env, SBSCORE_API: apiUrl } },
    );
    // Vite announces itself as `Local: http://127.0.0.1:PORT/`, not JSON, so scrape that line —
    // then poll it, because "printed the banner" is a moment before "will serve a request".
    const uiUrl = (await scrapeViteUrl(vite, 30_000)).replace(/\/$/, '');
    await waitForHttp(`${uiUrl}/`, 20_000);

    const executablePath = discoverChromium();
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });

    const cli = (args: string[]): unknown => {
      const stdout = execFileSync('pnpm', ['sbscore', ...args, '--json'], {
        cwd: REPO,
        env: { ...process.env, SBSCORE_URL: apiUrl },
        encoding: 'utf8',
      });
      return JSON.parse(stdout);
    };

    return {
      apiUrl,
      uiUrl,
      browser,
      cli,
      scoreUrl: (id) => `${uiUrl}/#/score/${encodeURIComponent(id)}`,
      stop: teardown,
    };
  } catch (error) {
    await teardown();
    throw error;
  }
}

/** Vite prints `Local: http://127.0.0.1:PORT/`; pull the URL out of its stdout. */
function scrapeViteUrl(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolveWith, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`vite did not print a URL in ${timeoutMs}ms:\n${out}`)), timeoutMs);
    const onData = (chunk: Buffer): void => {
      out += chunk.toString();
      const match = /https?:\/\/127\.0\.0\.1:\d+\/?/.exec(out);
      if (match !== null) {
        clearTimeout(timer);
        resolveWith(match[0]);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
  });
}
