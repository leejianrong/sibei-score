import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The CLI as a program, not as a function.
 *
 * `tests/cli/cli.test.ts` drives `run()` in-process, which is fast and covers the behaviour. This
 * covers what that cannot: **an exit code is only a contract if the shell sees it.** ADR-0008 says the
 * codes must be distinct enough to branch on without parsing prose, and a caller branches on
 * `$?`, not on a returned number — a `process.exit` missing from `bin.ts` would leave every
 * in-process test green and every script broken.
 *
 * It also exercises `sibei serve`, which is the only way the CLI is usable at all and which nothing
 * else starts.
 */

const REPO = resolve(import.meta.dirname, '../..');
const BIN = join(REPO, 'packages/cli/src/bin.ts');

let directory: string;
let server: ReturnType<typeof spawn>;
let url: string;

/** Run the CLI as a real child process and report what the shell would see. */
function sibei(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('node', ['--import', 'tsx', BIN, ...argv], {
      cwd: REPO,
      env: { ...process.env, SIBEI_URL: url },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'sibei-cli-'));
  server = spawn('node', ['--import', 'tsx', BIN, 'serve', '--port', '0', '--json'], {
    cwd: REPO,
    env: { ...process.env, SIBEI_DATA: join(directory, 'scores.db') },
  });

  // `serve --json` prints where it bound, which is how a caller finds an ephemeral port.
  url = await new Promise<string>((resolvePromise, reject) => {
    let output = '';
    let problems = '';
    // Report the server's own stderr on a timeout. The first run of this failed with only "the server
    // did not start", when the server had in fact said exactly what was wrong on the line before.
    const timer = setTimeout(
      () => reject(new Error(`the server did not start. It said: ${problems || '(nothing)'}`)),
      20_000,
    );
    server.stderr?.on('data', (chunk) => (problems += String(chunk)));
    server.stdout?.on('data', (chunk) => {
      output += String(chunk);
      const match = /"listening":"([^"]+)"/.exec(output);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolvePromise(match[1]);
      }
    });
    server.on('error', reject);
    server.on('close', () => {
      clearTimeout(timer);
      reject(new Error(`the server exited before binding. It said: ${problems || '(nothing)'}`));
    });
  });
}, 30_000);

afterAll(() => {
  server.kill('SIGTERM');
  rmSync(directory, { recursive: true, force: true });
});

describe('sibei serve', () => {
  it('starts, binds loopback, and says where the charts live', () => {
    // The one place a store path is legitimately printed: the operator asked to start a server.
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('answers a health check from a separate process', async () => {
    const result = await sibei('health');
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('ok · api v1');
  });
});

describe('the exit codes reach the shell (ADR-0008)', () => {
  it('0 on success', async () => {
    expect((await sibei('new', '--id', 'subprocess-1', '--bars', '4')).code).toBe(0);
  });

  it('1 on usage', async () => {
    expect((await sibei('nonsense')).code).toBe(1);
  });

  it('2 on a validation failure', async () => {
    await sibei('new', '--id', 'subprocess-2', '--bars', '4');
    const result = await sibei('note', 'add', 'subprocess-2', 'bar1.beat1', '--pitch', 'H9', '--dur', '4');
    expect(result.code).toBe(2);
  });

  it('3 on a bad address, with the onsets on stderr', async () => {
    await sibei('new', '--id', 'subprocess-3', '--bars', '4');
    await sibei('note', 'add', 'subprocess-3', 'bar1.beat1', '--pitch', 'C5', '--dur', '4');
    const result = await sibei('note', 'set', 'subprocess-3', 'bar1.beat3', '--pitch', 'D5');
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('onsets are 1');
    // Errors on stderr, output on stdout, so a caller can pipe one without the other.
    expect(result.stdout).toBe('');
  });

  it('4 on a stale-version conflict — the demo’s exit code', async () => {
    await sibei('new', '--id', 'subprocess-4', '--bars', '4');
    await sibei('note', 'add', 'subprocess-4', 'bar1.beat1', '--pitch', 'C5', '--dur', '4');

    const first = await sibei('note', 'set', 'subprocess-4', 'bar1.n1', '--pitch', 'D5', '--if-version', '2');
    expect(first.code).toBe(0);

    const second = await sibei('note', 'set', 'subprocess-4', 'bar1.n1', '--pitch', 'E5', '--if-version', '2');
    expect(second.code).toBe(4);
    expect(second.stderr).toContain('the score is at version 3, not 2');
  });

  it('5 on a score that is not there', async () => {
    expect((await sibei('show', 'nope')).code).toBe(5);
  });

  it('6 when the server is not running', async () => {
    const result = await new Promise<{ code: number; stderr: string }>((resolvePromise) => {
      const child = spawn('node', ['--import', 'tsx', BIN, 'list'], {
        cwd: REPO,
        env: { ...process.env, SIBEI_URL: 'http://127.0.0.1:1' },
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += String(chunk)));
      child.on('close', (code) => resolvePromise({ code: code ?? -1, stderr }));
    });
    expect(result.code).toBe(6);
    expect(result.stderr).toContain('sibei serve');
  });

  it('8 on an id that is taken', async () => {
    await sibei('new', '--id', 'subprocess-8', '--bars', '4');
    expect((await sibei('new', '--id', 'subprocess-8')).code).toBe(8);
  });
});

describe('the demo, as a shell would run it', () => {
  it('authors a chart and shows it', async () => {
    const id = 'subprocess-demo';
    expect((await sibei('new', '--id', id, '--title', 'Body and Soul', '--key', 'Db', '--bars', '8')).code).toBe(0);
    for (const [address, pitch, duration] of [
      ['bar1.beat1', 'Db5', '8'],
      ['bar1.beat1.5', 'Eb5', '8'],
      ['bar1.beat2', 'F5', '4'],
      ['bar1.beat3', 'Gb5', '2'],
    ] as const) {
      expect((await sibei('note', 'add', id, address, '--pitch', pitch, '--dur', duration)).code).toBe(0);
    }

    const shown = await sibei('show', id);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('Body and Soul — key Db, 4/4, 8 bars');
    expect(shown.stdout).toContain('n1 db5/8  n2 eb5/8  n3 f5/4  n4 gb5/2');
    expect(shown.stdout).toContain('Address:');
  });

  it('survives a restart, because the store is a file and not a process', async () => {
    // The library is persistent. Nothing in the CLI holds state between invocations, which is the
    // point of the server owning the score (ADR-0002).
    const listed = await sibei('list');
    expect(listed.stdout).toContain('subprocess-demo');
    expect(listed.stdout).toContain('Body and Soul');
  });
});
