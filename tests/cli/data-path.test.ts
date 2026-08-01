import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adoptLegacyDataDirectory, defaultDataPath } from '@sibei/cli';

/**
 * Where the library lives, and the one-time adoption of the directory it lived in before the binary
 * was renamed `sibei` -> `sbscore` (KAN-599, 2026-08-01).
 *
 * **This is the only part of that rename that could destroy something.** The default data directory
 * is named after the binary, so renaming the binary renames the directory — and a rename with no
 * adoption leaves a real library sitting unreferenced while a fresh empty database appears beside
 * it. Nothing errors. Nothing warns. It does not fail, it lies, which is the failure shape ADR-0028
 * exists to keep out of this store.
 *
 * Real temp directories throughout, and `XDG_DATA_HOME` is what points at them: a test that stubbed
 * the filesystem would be asserting against its own stub, and the thing under test here is a
 * `rename(2)`.
 */

let home: string;
let savedXdg: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sbscore-data-'));
  savedXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = home;
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdg;
  rmSync(home, { recursive: true, force: true });
});

const legacyDirectory = (): string => join(home, 'sibei');
const currentDirectory = (): string => join(home, 'sbscore');

/**
 * A library that looks like one: the database, the WAL sidecars the store leaves beside it, and the
 * `blobs/` directory of cached exports. The sidecars are here because a file-by-file move would
 * have had to know about them and a directory move does not.
 */
function aLibraryAt(directory: string, marker: string): void {
  mkdirSync(join(directory, 'blobs'), { recursive: true });
  writeFileSync(join(directory, 'scores.db'), marker);
  writeFileSync(join(directory, 'scores.db-wal'), `${marker}-wal`);
  writeFileSync(join(directory, 'blobs', 'export.pdf'), `${marker}-blob`);
}

describe('the default data path', () => {
  it('is named after the binary, under XDG_DATA_HOME', () => {
    expect(defaultDataPath()).toBe(join(home, 'sbscore', 'scores.db'));
  });

  it('falls back to ~/.local/share when XDG_DATA_HOME is unset or empty', () => {
    // The XDG spec's own fallback. Asserted through the shape rather than the home directory,
    // because the test does not get to choose whose machine it runs on.
    delete process.env.XDG_DATA_HOME;
    expect(defaultDataPath()).toMatch(/[/\\]\.local[/\\]share[/\\]sbscore[/\\]scores\.db$/);

    process.env.XDG_DATA_HOME = '';
    expect(defaultDataPath()).toMatch(/[/\\]\.local[/\\]share[/\\]sbscore[/\\]scores\.db$/);
  });
});

describe('adopting the pre-rename data directory', () => {
  it('moves it when the old path exists and the new one does not', () => {
    aLibraryAt(legacyDirectory(), 'the real library');

    const adoption = adoptLegacyDataDirectory();

    expect(adoption).toEqual({ kind: 'adopted', from: legacyDirectory(), to: currentDirectory() });
    expect(existsSync(legacyDirectory())).toBe(false);
    expect(readFileSync(join(currentDirectory(), 'scores.db'), 'utf8')).toBe('the real library');

    // `blobs/` and the WAL sidecar came with it, because one `rename` of the directory takes
    // everything in it. Dropping the cache would have been defensible (Q81 regenerates it); losing
    // a `-wal` holding committed data would not.
    expect(readFileSync(join(currentDirectory(), 'scores.db-wal'), 'utf8')).toBe('the real library-wal');
    expect(readFileSync(join(currentDirectory(), 'blobs', 'export.pdf'), 'utf8')).toBe('the real library-blob');
  });

  it('is idempotent: the second call has nothing to do', () => {
    aLibraryAt(legacyDirectory(), 'once');

    expect(adoptLegacyDataDirectory().kind).toBe('adopted');
    expect(adoptLegacyDataDirectory()).toEqual({ kind: 'nothing-to-do' });
    expect(adoptLegacyDataDirectory()).toEqual({ kind: 'nothing-to-do' });
    expect(readFileSync(join(currentDirectory(), 'scores.db'), 'utf8')).toBe('once');
  });

  it('never overwrites an existing new-path library when both exist', () => {
    aLibraryAt(legacyDirectory(), 'the old one');
    aLibraryAt(currentDirectory(), 'the one in use');

    const adoption = adoptLegacyDataDirectory();

    expect(adoption).toEqual({
      kind: 'both-exist',
      legacy: legacyDirectory(),
      current: currentDirectory(),
    });
    // Neither is touched. The one in use is still the one in use, and the older one is still there
    // to be dealt with by hand — which is what the notice on stdout tells the operator to do.
    expect(readFileSync(join(currentDirectory(), 'scores.db'), 'utf8')).toBe('the one in use');
    expect(readFileSync(join(legacyDirectory(), 'scores.db'), 'utf8')).toBe('the old one');
  });

  it('does nothing at all on a fresh machine where neither exists', () => {
    expect(adoptLegacyDataDirectory()).toEqual({ kind: 'nothing-to-do' });
    expect(existsSync(legacyDirectory())).toBe(false);
    // It must not *create* the new directory either. `serve` does that, after it has decided where
    // the library is; creating it here would make the both-exist branch fire on the next run.
    expect(existsSync(currentDirectory())).toBe(false);
  });

  it('treats a stray file at the old name as absent rather than moving it', () => {
    // Nobody's library. Moving it would leave a file where the code then expects a directory.
    writeFileSync(legacyDirectory(), 'not a library');

    expect(adoptLegacyDataDirectory()).toEqual({ kind: 'nothing-to-do' });
    expect(readFileSync(legacyDirectory(), 'utf8')).toBe('not a library');
  });
});

/**
 * The same thing through the real program, because `serve` is where the adoption is wired and the
 * wiring is the part that can be wrong: it must run for the *default* path and must not run when a
 * path was named. A chart authored under the old name and read back under the new one is the
 * property this card exists for, and nothing short of two real servers proves it.
 */
describe('serve adopts the library it starts on', () => {
  const REPO = resolve(import.meta.dirname, '../..');
  const BIN = join(REPO, 'packages/cli/src/bin.ts');

  interface Started {
    url: string;
    line: Record<string, unknown>;
    stop: () => void;
  }

  /** Start `serve --port 0 --json` under a given environment and read the line it prints. */
  function startServer(env: Record<string, string | undefined>): Promise<Started> {
    const child = spawn('node', ['--import', 'tsx', BIN, 'serve', '--port', '0', '--json'], {
      cwd: REPO,
      env: { ...process.env, ...env },
    });
    return new Promise<Started>((resolvePromise, reject) => {
      let output = '';
      let problems = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`the server did not start. It said: ${problems || '(nothing)'}`));
      }, 25_000);
      child.stderr?.on('data', (chunk) => (problems += String(chunk)));
      child.stdout?.on('data', (chunk) => {
        output += String(chunk);
        if (!output.includes('\n')) return;
        clearTimeout(timer);
        const line = JSON.parse(output.slice(0, output.indexOf('\n'))) as Record<string, unknown>;
        resolvePromise({
          url: String(line['listening']),
          line,
          stop: () => child.kill('SIGTERM'),
        });
      });
      child.on('error', reject);
      child.on('close', () => {
        clearTimeout(timer);
        reject(new Error(`the server exited before binding. It said: ${problems || '(nothing)'}`));
      });
    });
  }

  /** One CLI command against a given server. */
  function cli(url: string, ...argv: string[]): Promise<{ code: number; stdout: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn('node', ['--import', 'tsx', BIN, ...argv], {
        cwd: REPO,
        env: { ...process.env, SBSCORE_URL: url },
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += String(chunk)));
      child.on('error', reject);
      child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout }));
    });
  }

  it(
    'carries a chart authored before the rename into the renamed directory',
    async () => {
      // A genuine pre-rename library: written by the store itself, at the old default path.
      const before = await startServer({
        XDG_DATA_HOME: home,
        SBSCORE_DATA: join(legacyDirectory(), 'scores.db'),
      });
      expect((await cli(before.url, 'new', '--id', 'inherited', '--title', 'Stella', '--bars', '4')).code).toBe(0);
      before.stop();
      await new Promise((r) => setTimeout(r, 500));
      expect(existsSync(join(legacyDirectory(), 'scores.db'))).toBe(true);

      // Now start the renamed binary the way an operator would, with no path named at all.
      const after = await startServer({ XDG_DATA_HOME: home, SBSCORE_DATA: undefined });
      try {
        expect(after.line['data']).toBe(join(currentDirectory(), 'scores.db'));
        expect(after.line['dataDirectory']).toEqual({
          kind: 'adopted',
          from: legacyDirectory(),
          to: currentDirectory(),
        });
        // The point of all of it: the chart is still there.
        const listed = await cli(after.url, 'list');
        expect(listed.stdout).toContain('inherited');
        expect(listed.stdout).toContain('Stella');
      } finally {
        after.stop();
      }
    },
    90_000,
  );

  it(
    'leaves the old directory alone when a path was named explicitly',
    async () => {
      aLibraryAt(legacyDirectory(), 'not yours to move');
      const named = join(home, 'elsewhere', 'scores.db');

      const started = await startServer({ XDG_DATA_HOME: home, SBSCORE_DATA: named });
      try {
        expect(started.line['data']).toBe(named);
        // No adoption ran, so the key is absent rather than reporting `nothing-to-do`.
        expect(started.line['dataDirectory']).toBeUndefined();
        expect(readFileSync(join(legacyDirectory(), 'scores.db'), 'utf8')).toBe('not yours to move');
        expect(existsSync(currentDirectory())).toBe(false);
      } finally {
        started.stop();
      }
    },
    60_000,
  );
});
