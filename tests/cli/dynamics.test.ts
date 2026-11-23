import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Api, ScoreStore } from '@sibei/api';
import { EXIT, run } from '@sibei/cli';
import { barViews } from '@sibei/model';
import type { Score } from '@sibei/model';

/** `sbscore dynamic` and `sbscore hairpin` over a real server (SIB2-274, ADR-0021 amendment). */

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

async function open(): Promise<Score> {
  return (JSON.parse((await sbscore('open', 'tune', '--json')).out) as { score: Score }).score;
}

async function twoNotes(): Promise<void> {
  await sbscore('new', '--id', 'tune', '--bars', '2');
  await sbscore('note', 'add', 'tune', 'bar1.beat1', '--pitch', 'C5', '--dur', '4');
  await sbscore('note', 'add', 'tune', 'bar1.beat2', '--pitch', 'D5', '--dur', '4');
  await sbscore('note', 'add', 'tune', 'bar2.beat1', '--pitch', 'E5', '--dur', '4');
}

describe('sbscore dynamic', () => {
  it('sets, replaces and removes a dynamic, shows it, and undoes it', async () => {
    await twoNotes();
    expect((await sbscore('dynamic', 'set', 'tune', 'bar1.n1', 'mf')).code).toBe(EXIT.ok);
    expect(barViews(await open())[0]!.items[0]!.dynamic).toBe('mf');
    expect((await sbscore('show', 'tune')).out).toContain('c5/4@mf');
    await sbscore('dynamic', 'set', 'tune', 'bar1.n1', 'ff');
    expect(barViews(await open())[0]!.items[0]!.dynamic).toBe('ff');
    await sbscore('undo', 'tune');
    expect(barViews(await open())[0]!.items[0]!.dynamic).toBe('mf');
    expect((await sbscore('dynamic', 'rm', 'tune', 'bar1.n1')).code).toBe(EXIT.ok);
    expect(barViews(await open())[0]!.items[0]!.dynamic).toBeUndefined();
  });

  it('refuses an unknown dynamic, a missing one, and removing what is not there', async () => {
    await twoNotes();
    expect((await sbscore('dynamic', 'set', 'tune', 'bar1.n1', 'loud')).code).not.toBe(EXIT.ok);
    expect((await sbscore('dynamic', 'set', 'tune', 'bar1.n1')).code).toBe(EXIT.usage);
    expect((await sbscore('dynamic', 'rm', 'tune', 'bar1.n1')).code).not.toBe(EXIT.ok);
    expect((await sbscore('dynamic', 'frobnicate', 'tune', 'bar1.n1')).code).toBe(EXIT.usage);
  });
});

describe('sbscore hairpin', () => {
  it('sets a crescendo across a barline, lists it in show, removes it by id, and undoes it', async () => {
    await twoNotes();
    expect((await sbscore('hairpin', 'set', 'tune', 'bar1.n1', 'bar2.n1', '--cresc')).code).toBe(EXIT.ok);
    expect((await open()).spanners).toEqual([expect.objectContaining({ kind: 'hairpin', hairpin: 'crescendo' })]);
    expect((await sbscore('show', 'tune')).out).toContain('hairpin  bar1.n1 -> bar2.n1 cresc hairpin-1');
    await sbscore('hairpin', 'rm', 'tune', 'hairpin-1');
    expect((await open()).spanners).toBeUndefined();
    await sbscore('undo', 'tune');
    expect((await open()).spanners).toHaveLength(1);
  });

  it('wants exactly one of --cresc and --dim, and refuses a reversed run', async () => {
    await twoNotes();
    expect((await sbscore('hairpin', 'set', 'tune', 'bar1.n1', 'bar2.n1')).code).toBe(EXIT.usage);
    expect((await sbscore('hairpin', 'set', 'tune', 'bar1.n1', 'bar2.n1', '--cresc', '--dim')).code).toBe(EXIT.usage);
    expect((await sbscore('hairpin', 'set', 'tune', 'bar2.n1', 'bar1.n1', '--dim')).code).not.toBe(EXIT.ok);
  });
});
