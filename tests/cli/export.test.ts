import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, openSqliteStore, silentLogger } from '@sibei/api';
import type { Api, ScoreStore } from '@sibei/api';
import { EXIT, createClient, run } from '@sibei/cli';
import type { Client } from '@sibei/cli';

/**
 * `sibei export --pdf` (V3d), against a real server over real HTTP.
 *
 * The verb is the closing beat of V3's demo — author a chart from the CLI, then get a printable
 * page out of it — and it is the first one that writes a file. Two things are therefore worth more
 * than the happy path: that the CLI renders nothing itself (`no-second-render-path.test.ts`), and
 * that a filename which arrived over a socket cannot decide where the file goes.
 *
 * Every command runs with `cwd` pointed at a throwaway directory, because a test that writes a PDF
 * into the repository is a test that leaves one behind.
 */

let store: ScoreStore;
let api: Api;
let baseUrl: string;
let work: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  store = openSqliteStore({ filename: ':memory:' });
  api = createApi({ store, logger: silentLogger });
  const { port } = await api.listen(0);
  baseUrl = `http://127.0.0.1:${port}`;
  work = mkdtempSync(join(tmpdir(), 'sibei-export-'));
  out = [];
  err = [];
});

afterEach(async () => {
  await api.close();
  store.close();
  rmSync(work, { recursive: true, force: true });
});

async function sibei(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  out = [];
  err = [];
  const code = await run(argv, {
    baseUrl,
    cwd: work,
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** The same, with the client replaced — for the failures a real server cannot be made to produce. */
async function sibeiWith(client: Client, ...argv: string[]): Promise<{ code: number; out: string }> {
  out = [];
  err = [];
  const code = await run(argv, {
    client,
    cwd: work,
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
  });
  return { code, out: out.join('\n') };
}

const json = <T>(text: string): T => JSON.parse(text) as T;

async function aChart(): Promise<void> {
  await sibei('new', '--id', 'soul', '--title', 'Body and Soul', '--composer', 'Johnny Green', '--key', 'Db', '--bars', '8');
  await sibei('note', 'add', 'soul', 'bar1.beat1', '--pitch', 'Db5', '--dur', '4');
}

/** A file that begins `%PDF-` is a PDF; anything shorter came back mangled. */
function isPdf(path: string): boolean {
  return readFileSync(path).subarray(0, 5).toString('latin1') === '%PDF-';
}

describe('sibei export writes a real PDF', () => {
  it('names the file after the chart and puts it in the working directory', async () => {
    await aChart();
    const result = await sibei('export', 'soul');
    expect(result.code).toBe(EXIT.ok);

    const path = join(work, 'Body and Soul.pdf');
    expect(readdirSync(work)).toEqual(['Body and Soul.pdf']);
    expect(isPdf(path)).toBe(true);
    expect(result.out).toContain(path);
    expect(result.out).toMatch(/\d+ bytes$/);
  });

  it('writes exactly where -o names a file', async () => {
    await aChart();
    const path = join(work, 'chart.pdf');
    expect((await sibei('export', 'soul', '-o', path)).code).toBe(EXIT.ok);
    expect(isPdf(path)).toBe(true);
  });

  it('puts the chart’s name inside -o when -o is a directory', async () => {
    await aChart();
    const existing = mkdtempSync(join(work, 'exports-'));
    // An existing directory is taken as one, with or without the trailing separator.
    expect((await sibei('export', 'soul', '-o', existing)).code).toBe(EXIT.ok);
    expect(isPdf(join(existing, 'Body and Soul.pdf'))).toBe(true);

    rmSync(join(existing, 'Body and Soul.pdf'));
    expect((await sibei('export', 'soul', '-o', `${existing}/`)).code).toBe(EXIT.ok);
    expect(isPdf(join(existing, 'Body and Soul.pdf'))).toBe(true);
  });

  it('says which path it could not write, rather than failing obscurely', async () => {
    await aChart();
    const result = await sibei('export', 'soul', '-o', join(work, 'nowhere', 'chart.pdf'));
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toContain(join(work, 'nowhere', 'chart.pdf'));
  });

  it('is a no-op on the score: an export is a read (Q81)', async () => {
    await aChart();
    const before = store.get('local', 'soul')?.version;
    await sibei('export', 'soul');
    expect(store.get('local', 'soul')?.version).toBe(before);
  });

  it('--pdf is optional and means what the default means', async () => {
    await aChart();
    await sibei('export', 'soul', '-o', join(work, 'implicit.pdf'));
    await sibei('export', 'soul', '--pdf', '-o', join(work, 'explicit.pdf'));
    expect(readFileSync(join(work, 'explicit.pdf'))).toEqual(readFileSync(join(work, 'implicit.pdf')));
  });

  it('passes the paper and the face through, so they reach the page', async () => {
    // The CLI has no opinion about either (ADR-0030 makes the face the reader's choice per render);
    // all it has to do is carry them. Different bytes is the evidence they arrived.
    await aChart();
    await sibei('export', 'soul', '-o', join(work, 'a4-normal.pdf'));
    await sibei('export', 'soul', '--paper', 'letter', '-o', join(work, 'letter.pdf'));
    await sibei('export', 'soul', '--font', 'jazz', '-o', join(work, 'jazz.pdf'));

    const a4 = readFileSync(join(work, 'a4-normal.pdf'));
    expect(readFileSync(join(work, 'letter.pdf'))).not.toEqual(a4);
    expect(readFileSync(join(work, 'jazz.pdf'))).not.toEqual(a4);
  });

  it('serves the same bytes the second time, which is the cache doing its job', async () => {
    await aChart();
    await sibei('export', 'soul', '-o', join(work, 'first.pdf'));
    await sibei('export', 'soul', '-o', join(work, 'second.pdf'));
    expect(readFileSync(join(work, 'second.pdf'))).toEqual(readFileSync(join(work, 'first.pdf')));
  });
});

describe('--json, because an agent should never parse prose', () => {
  it('reports the path and the byte count, and never the bytes', async () => {
    await aChart();
    const result = await sibei('export', 'soul', '--json');
    expect(result.code).toBe(EXIT.ok);

    const report = json<{ scoreId: string; path: string; bytes: number; contentType: string }>(result.out);
    expect(report.scoreId).toBe('soul');
    expect(report.contentType).toBe('application/pdf');
    expect(report.bytes).toBe(statSync(report.path).size);
    expect(result.out).not.toContain('%PDF');
  });
});

describe('the exit codes hold for export too (ADR-0008)', () => {
  it('2 for a paper this build cannot produce, with the list of what it can', async () => {
    await aChart();
    const result = await sibei('export', 'soul', '--paper', 'a5');
    expect(result.code).toBe(EXIT.validation);
    // The error is the feature: the supported list is in the prose the server wrote.
    expect(result.err).toContain('try a4 or letter');
    expect(readdirSync(work)).toEqual([]);
  });

  it('2 for a face it does not have, with the list one level down in --json', async () => {
    await aChart();
    const result = await sibei('export', 'soul', '--font', 'swing', '--json');
    expect(result.code).toBe(EXIT.validation);

    const failure = json<{ error: { kind: string; detail: { supported: string[] } } }>(result.err);
    expect(failure.error.kind).toBe('unsupported-font');
    expect(failure.error.detail.supported).toEqual(['normal', 'jazz']);
  });

  it('5 for a score that is not there, and nothing is written', async () => {
    expect((await sibei('export', 'nope')).code).toBe(EXIT.notFound);
    expect(readdirSync(work)).toEqual([]);
  });

  it('1 for usage: no id, and -o with nothing after it', async () => {
    expect((await sibei('export')).code).toBe(EXIT.usage);
    const dangling = await sibei('export', 'soul', '-o');
    expect(dangling.code).toBe(EXIT.usage);
    expect(dangling.err).toContain('-o needs a value');
  });
});

describe('a filename that came off a socket is not a path', () => {
  /** A client that answers with whatever name the test wants. A hostile server, in other words. */
  function serverSaying(filename: string): Client {
    return {
      ...createClient(baseUrl),
      exportScore: () =>
        Promise.resolve({
          bytes: Buffer.from('%PDF-1.3 not really'),
          filename,
          contentType: 'application/pdf',
        }),
    };
  }

  it('cannot climb out of the directory the caller chose', async () => {
    const directory = mkdtempSync(join(work, 'chosen-'));
    const result = await sibeiWith(serverSaying('../../../pwned.pdf'), 'export', 'soul', '-o', directory);

    expect(result.code).toBe(EXIT.ok);
    // The name is taken, the path it implied is not: the file is in the chosen directory, and
    // nothing landed in the one above it.
    expect(readdirSync(directory)).toEqual(['pwned.pdf']);
    expect(readdirSync(work)).toEqual([basename(directory)]);
  });

  it('cannot become an absolute path', async () => {
    const directory = mkdtempSync(join(work, 'chosen-'));
    const target = join(work, 'absolute.pdf');
    await sibeiWith(serverSaying(target), 'export', 'soul', '-o', directory);

    expect(readdirSync(directory)).toEqual(['absolute.pdf']);
    expect(readdirSync(work).some((entry) => entry === 'absolute.pdf')).toBe(false);
  });

  it('falls back to a name of its own when the suggestion is not a filename at all', async () => {
    const directory = mkdtempSync(join(work, 'chosen-'));
    for (const hostile of ['', '..', '.', '../../../', 'evil\u0000.pdf']) {
      rmSync(join(directory, 'soul.pdf'), { force: true });
      const result = await sibeiWith(serverSaying(hostile), 'export', 'soul', '-o', directory);
      expect(result.code).toBe(EXIT.ok);
      // `soul` is the score id, which is the only name the CLI knows on its own.
      expect(readdirSync(directory)).toEqual(['soul.pdf']);
    }
  });

  it('sanitises a score id before using it as a name, because that is user text too', async () => {
    const directory = mkdtempSync(join(work, 'chosen-'));
    await sibeiWith(serverSaying(''), 'export', '../../etc/passwd', '-o', directory);
    expect(readdirSync(directory)).toEqual(['-etc-passwd.pdf']);
  });
});
