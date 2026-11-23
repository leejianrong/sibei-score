import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Api, ScoreStore } from '@sibei/api';
import { EXIT, run } from '@sibei/cli';
import { layout } from '@sibei/layout';
import { barViews } from '@sibei/model';
import type { BarView, Score } from '@sibei/model';

/**
 * `sbscore tuplet set|rm` over a real server (SIB2-166). The applier owns the change; this asserts the
 * CLI reaches it, the bracket persists and shows in `show`, and the bar is not flagged.
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
  await store.close();
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

const barAt = (score: Score, n: number): BarView => barViews(score).find((b) => b.number === n)!;

describe('sbscore tuplet', () => {
  it('brackets three eighths, shows them as (3), and undoes as one unit', async () => {
    await sbscore('new', '--id', 'tune', '--bars', '4');
    await sbscore('note', 'add', 'tune', 'bar3.beat1', '--pitch', 'C5', '--dur', '4');
    for (const [at, pitch] of [['bar3.beat2', 'D5'], ['bar3.beat2.5', 'E5'], ['bar3.beat3', 'F5']] as const) {
      await sbscore('note', 'add', 'tune', at, '--pitch', pitch, '--dur', '8');
    }
    await sbscore('note', 'add', 'tune', 'bar3.beat3.5', '--pitch', 'G5', '--dur', '2');

    const set = await sbscore('tuplet', 'set', 'tune', 'bar3.beat2', '--notes', '3', '--in', '2', '--over', '3');
    expect(set.code).toBe(EXIT.ok);
    expect(barAt(await open(), 3).tuplets[0]).toMatchObject({ actual: 3, normal: 2 });
    const shown = await sbscore('show', 'tune');
    expect(shown.out).toContain('(3)');
    expect(shown.out).not.toMatch(/bar 3.*!/);

    expect((await sbscore('undo', 'tune')).code).toBe(EXIT.ok);
    expect(barAt(await open(), 3).tuplets).toEqual([]);
    expect((await sbscore('redo', 'tune')).code).toBe(EXIT.ok);
    expect((await sbscore('tuplet', 'rm', 'tune', 'bar3.beat2')).code).toBe(EXIT.ok);
    expect(barAt(await open(), 3).tuplets).toEqual([]);
  });

  it('defaults --in and refuses a run that overshoots the bar', async () => {
    await sbscore('new', '--id', 'tune', '--bars', '4');
    await sbscore('note', 'add', 'tune', 'bar1.beat1', '--pitch', 'C5', '--dur', '4');
    const result = await sbscore('tuplet', 'set', 'tune', 'bar1.beat1', '--notes', '3');
    expect(result.code).not.toBe(EXIT.ok);
    expect(result.err).toContain('only 1 item');
  });
});
