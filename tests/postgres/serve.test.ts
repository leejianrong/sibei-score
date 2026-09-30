import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pg, provisionDatabase } from './support.js';
import type { TestDatabase } from './support.js';

/**
 * `sbscore serve --database-url` against a real Postgres, as a real process (V19, ADR-0034): the
 * composition root wired end to end. A chart authored through the CLI lands in Postgres, survives the
 * server being restarted, and no credential appears in anything the server prints.
 */

const REPO = resolve(import.meta.dirname, '../..');
const BIN = join(REPO, 'packages/cli/src/bin.ts');

let database: TestDatabase;
let blobs: string;
const running: Array<() => void> = [];

beforeEach(async () => {
  database = await provisionDatabase();
  blobs = mkdtempSync(join(tmpdir(), 'sbscore-pg-blobs-'));
});

afterEach(async () => {
  while (running.length > 0) running.pop()!();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300)); // let the server release its pool
  await database.drop();
  rmSync(blobs, { recursive: true, force: true });
});

interface Started {
  url: string;
  line: Record<string, unknown>;
  raw: string;
  stop(): Promise<void>;
}

function startServer(args: string[], env: Record<string, string | undefined> = {}): Promise<Started> {
  const child = spawn('node', ['--import', 'tsx', BIN, 'serve', '--port', '0', '--json', ...args], {
    cwd: REPO,
    env: { ...process.env, SBSCORE_BLOBS: blobs, SBSCORE_DATA: undefined, ...env },
  });
  running.push(() => child.kill('SIGKILL'));
  return new Promise<Started>((resolvePromise, reject) => {
    let output = '';
    let problems = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the server did not start. It said: ${problems || '(nothing)'}`));
    }, 30_000);
    child.stderr?.on('data', (chunk) => (problems += String(chunk)));
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
      if (!output.includes('\n')) return;
      clearTimeout(timer);
      const raw = output.slice(0, output.indexOf('\n'));
      const line = JSON.parse(raw) as Record<string, unknown>;
      resolvePromise({
        url: String(line['listening']),
        line,
        raw,
        stop: () =>
          new Promise<void>((done) => {
            child.once('close', () => done());
            child.kill('SIGTERM');
          }),
      });
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`the server exited with ${code} before it printed anything. It said: ${problems || '(nothing)'}`));
    });
  });
}

function exitOf(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('node', ['--import', 'tsx', BIN, ...args], { cwd: REPO, env: { ...process.env, SBSCORE_DATA: undefined, ...env } });
    running.push(() => child.kill('SIGKILL'));
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stderr, stdout }));
  });
}

function cli(url: string, ...argv: string[]): Promise<{ code: number; stdout: string }> {
  return exitOf([...argv], { SBSCORE_URL: url });
}

describe('sbscore serve --database-url', () => {
  it(
    'serves charts out of Postgres, keeps them across a restart, and prints no credential',
    async () => {
      const first = await startServer(['--database-url', database.url]);
      // Says where the charts are without saying how to get in.
      // The host is whatever the URL said (`localhost` in CI, `127.0.0.1` under Compose), not a constant.
      expect(first.line['database']).toBe(`postgres://${new URL(database.url).host}/${database.name}`);
      expect(first.line).not.toHaveProperty('data');
      expect(first.raw).not.toMatch(/sibei_app/); // neither the role nor its password appears

      expect((await cli(first.url, 'new', '--id', 'in-postgres', '--title', 'Stella', '--bars', '4', '--json')).code).toBe(0);
      await first.stop();

      // A new process, the same database: the chart is there.
      const second = await startServer([], { SBSCORE_DATABASE_URL: database.url });
      const listed = await cli(second.url, 'list', '--json');
      expect(listed.code).toBe(0);
      expect(listed.stdout).toMatch(/in-postgres/);
      await second.stop();

      // And it really is in Postgres, under the owner the local principal resolves to.
      const admin = new pg.Client({ connectionString: database.superuserUrl });
      await admin.connect();
      try {
        const rows = await admin.query(`SELECT owner, id FROM scores`);
        expect(rows.rows).toEqual([{ owner: 'local', id: 'in-postgres' }]);
      } finally {
        await admin.end();
      }
    },
    90_000,
  );

  it('refuses --data together with --database-url rather than guess which was meant', async () => {
    const result = await exitOf(['serve', '--port', '0', '--data', join(blobs, 'x.db'), '--database-url', database.url]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/cannot be combined with --database-url/);
  });

  it('ignores the container image\'s ambient SBSCORE_DATA under a database URL, as it must', async () => {
    // The image sets SBSCORE_DATA=/data/scores.db by default; a hosted deployment adds a database URL and
    // must not trip over it. It is neither opened nor created.
    const server = await startServer(['--database-url', database.url], { SBSCORE_DATA: join(blobs, 'ambient', 'scores.db') });
    expect(server.line).not.toHaveProperty('data');
    await server.stop();
  }, 60_000);

  it('fails cleanly, and quotes no credential, when the database cannot be opened', async () => {
    // A database that does not exist fails on any server. (A wrong *password* would not on a `trust`
    // cluster, which accepts any, so it cannot be the failure under test; `redactCredentials` has its own
    // unit tests for a message that does quote the URL.)
    const missing = database.url.replace(`/${database.name}`, '/sibei_no_such_database').replace('sibei_app:sibei_app', 'sibei_app:pw-9f3c1');
    const result = await exitOf(['serve', '--port', '0', '--database-url', missing]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`could not open the Postgres database at postgres://${new URL(missing).host}/sibei_no_such_database`);
    expect(result.stderr + result.stdout).not.toMatch(/pw-9f3c1/);
  }, 60_000);

  it('refuses a superuser URL with the reason, and --allow-rls-bypass is the knowing way past it', async () => {
    const refused = await exitOf(['serve', '--port', '0', '--database-url', database.superuserUrl]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/superuser or has BYPASSRLS/);

    const allowed = await startServer(['--database-url', database.superuserUrl, '--allow-rls-bypass']);
    expect(allowed.line['database']).toBeDefined();
    await allowed.stop();
  }, 90_000);
});
