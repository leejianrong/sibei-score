import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Api, ScoreStore } from '@sibei/api';
import { EXIT, run } from '@sibei/cli';
import type { Score } from '@sibei/model';

/** `sbscore nav set|rm` over a real server (SIB2-175, ADR-0021 amendment): the CLI reaches the op and `show` lists it. */

let store: ScoreStore;
let api: Api;
let baseUrl: string;

beforeEach(async () => {
  store = openSqliteStore({ filename: ':memory:' });
  api = createApi({ store, logger: { request: () => {}, error: () => {} } });
  baseUrl = `http://127.0.0.1:${(await api.listen(0)).port}`;
});

afterEach(async () => {
  await api.close();
  await store.close();
});

async function sbscore(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { baseUrl, io: { out: (t) => out.push(t), err: (t) => err.push(t) } });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const navOf = async (n: number): Promise<string[] | undefined> => {
  const opened = await sbscore('open', 'tune', '--json');
  return (JSON.parse(opened.out) as { score: Score }).score.bars.find((b) => b.number === n)?.nav;
};

describe('sbscore nav', () => {
  it('sets a sign and a jump, lists them in show, and removes them one at a time or all at once', async () => {
    await sbscore('new', '--id', 'tune', '--bars', '8');
    expect((await sbscore('nav', 'set', 'tune', '1', '--segno')).code).toBe(EXIT.ok);
    expect((await sbscore('nav', 'set', 'tune', 'bar8', '--ds-al-coda')).code).toBe(EXIT.ok);
    expect(await navOf(1)).toEqual(['segno']);
    expect(await navOf(8)).toEqual(['ds-al-coda']);
    expect((await sbscore('show', 'tune')).out).toContain('navigation: segno at bar1, ds-al-coda at bar8');

    await sbscore('nav', 'set', 'tune', '1', '--coda');
    expect((await sbscore('nav', 'rm', 'tune', '1', '--segno')).code).toBe(EXIT.ok);
    expect(await navOf(1)).toEqual(['coda']);
    expect((await sbscore('nav', 'rm', 'tune', '1')).code).toBe(EXIT.ok);
    expect(await navOf(1)).toBeUndefined();
  });

  it('is undoable as one edit', async () => {
    await sbscore('new', '--id', 'tune', '--bars', '4');
    await sbscore('nav', 'set', 'tune', '2', '--fine');
    await sbscore('undo', 'tune');
    expect(await navOf(2)).toBeUndefined();
  });

  it('wants exactly one mark flag to set, and refuses a repeat or a missing mark as the server does', async () => {
    await sbscore('new', '--id', 'tune', '--bars', '4');
    expect((await sbscore('nav', 'set', 'tune', '1')).code).toBe(EXIT.usage);
    expect((await sbscore('nav', 'set', 'tune', '1', '--segno', '--coda')).code).toBe(EXIT.usage);
    expect((await sbscore('nav', 'frobnicate', 'tune', '1')).code).toBe(EXIT.usage);
    await sbscore('nav', 'set', 'tune', '1', '--segno');
    expect((await sbscore('nav', 'set', 'tune', '1', '--segno')).code).not.toBe(EXIT.ok);
    expect((await sbscore('nav', 'rm', 'tune', '2')).code).not.toBe(EXIT.ok);
  });
});
