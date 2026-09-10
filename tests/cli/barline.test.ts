import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Api, ScoreStore } from '@sibei/api';
import { EXIT, run } from '@sibei/cli';
import { layout } from '@sibei/layout';
import type { Bar, Score } from '@sibei/model';

/**
 * `sbscore barline set`, `repeat set`, `ending set|rm` over a real server (V7, ADR-0021). The
 * applier owns the change; this asserts the CLI reaches it, that it persists, and that the layout
 * the browser renders through picks it up — a repeat and its endings land on the bars the CLI named.
 */

let store: ScoreStore;
let api: Api;
let baseUrl: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  store = openSqliteStore({ filename: ':memory:' });
  api = createApi({ store, logger: { request: () => {}, error: () => {} } });
  const { port } = await api.listen(0);
  baseUrl = `http://127.0.0.1:${port}`;
  out = [];
  err = [];
});

afterEach(async () => {
  await api.close();
  store.close();
});

async function sbscore(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  out = [];
  err = [];
  const code = await run(argv, { baseUrl, io: { out: (t) => out.push(t), err: (t) => err.push(t) } });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

interface Document {
  score: Score;
}

async function open(): Promise<Score> {
  const opened = await sbscore('open', 'tune', '--json');
  return (JSON.parse(opened.out) as Document).score;
}

const barAt = (score: Score, n: number): Bar => score.bars.find((b) => b.number === n)!;

describe('sbscore barline', () => {
  it('sets a closing barline that open reads back', async () => {
    await sbscore('new', '--id', 'tune', '--bars', '16');
    const result = await sbscore('barline', 'set', 'tune', 'bar16', '--end', 'double');
    expect(result.code).toBe(EXIT.ok);
    expect(barAt(await open(), 16).endBarline).toBe('double');
  });

  it('refuses a barline set that changes nothing', async () => {
    await sbscore('new', '--id', 'tune', '--bars', '4');
    const result = await sbscore('barline', 'set', 'tune', 'bar1');
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toMatch(/--start or --end/);
  });
});

describe('sbscore repeat set', () => {
  it('puts a repeat-start and a repeat-end around the span, as one undoable batch', async () => {
    await sbscore('new', '--id', 'tune', '--bars', '20');
    const result = await sbscore('repeat', 'set', 'tune', 'bar12', 'bar19');
    expect(result.code).toBe(EXIT.ok);

    const score = await open();
    expect(barAt(score, 12).startBarline).toBe('repeat-start');
    expect(barAt(score, 19).endBarline).toBe('repeat-end');
  });
});

describe('sbscore ending', () => {
  it('sets 1st and 2nd endings that the layout renders over the named bars', async () => {
    await sbscore('new', '--id', 'tune', '--bars', '12');
    await sbscore('ending', 'set', 'tune', 'bar7', '--numbers', '1', '--role', 'start-stop');
    await sbscore('ending', 'set', 'tune', 'bar8', '--numbers', '2', '--role', 'start-stop');

    // Read through the layout the browser renders (ADR-0014): the endings are on bars 7 and 8.
    const result = layout(await open());
    const endingBars = result.pages
      .flatMap((page) => page.systems.flatMap((system) => system.bars))
      .filter((bar) => bar.items.some((item) => item.kind === 'ending'))
      .map((bar) => bar.barNumber)
      .sort((a, b) => a - b);
    expect(endingBars).toEqual([7, 8]);
  });

  it('removes an ending, and refuses removing one that is not there', async () => {
    await sbscore('new', '--id', 'tune', '--bars', '4');
    await sbscore('ending', 'set', 'tune', 'bar3', '--numbers', '1', '--role', 'start-stop');
    expect(barAt(await open(), 3).ending).not.toBeNull();

    const removed = await sbscore('ending', 'rm', 'tune', 'bar3');
    expect(removed.code).toBe(EXIT.ok);
    expect(barAt(await open(), 3).ending).toBeNull();

    const again = await sbscore('ending', 'rm', 'tune', 'bar3');
    expect(again.code).toBe(EXIT.validation);
    expect(again.err).toMatch(/carries no ending/);
  });

  it('rejects a bad pass-number list before it reaches the server', async () => {
    await sbscore('new', '--id', 'tune', '--bars', '4');
    const result = await sbscore('ending', 'set', 'tune', 'bar3', '--numbers', 'x', '--role', 'start');
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toMatch(/pass numbers/);
  });
});
