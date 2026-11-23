import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Api, ScoreStore } from '@sibei/api';
import { EXIT, run } from '@sibei/cli';
import { barViews } from '@sibei/model';
import type { Score } from '@sibei/model';

/** `sbscore lyric` and `sbscore lyrics` over a real server (SIB2-273, ADR-0021 amendment). */

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

async function fourNotes(): Promise<void> {
  await sbscore('new', '--id', 'tune', '--bars', '2');
  for (const [at, pitch] of [['bar1.beat1', 'C5'], ['bar1.beat2', 'D5'], ['bar2.beat1', 'E5'], ['bar2.beat2', 'F5']] as const) {
    await sbscore('note', 'add', 'tune', at, '--pitch', pitch, '--dur', '4');
  }
}

const sung = async (): Promise<string[]> =>
  barViews(await open()).flatMap((bar) => bar.items.map((item) => (item.kind === 'note' ? (item.lyrics ?? []).map((l) => `${l.verse}:${l.text}/${l.syllabic}`).join(' ') : '')));

describe('sbscore lyric', () => {
  it('sets a syllable from its hyphens, a verse and an extender, shows it, and undoes it', async () => {
    await fourNotes();
    expect((await sbscore('lyric', 'set', 'tune', 'bar1.n1', 'hel-')).code).toBe(EXIT.ok);
    expect((await sbscore('lyric', 'set', 'tune', 'bar1.n2', '--text', '-lo', '--extend')).code).toBe(EXIT.ok);
    expect((await sbscore('lyric', 'set', 'tune', 'bar1.n1', 'la', '--verse', '2')).code).toBe(EXIT.ok);
    expect(await sung()).toEqual(['1:hel/begin 2:la/single', '1:lo/end', '', '']);
    const shown = (await sbscore('show', 'tune')).out;
    expect(shown).toContain('c5/4"hel-"2"la"');
    expect(shown).toContain('d5/4"-lo"_');
    await sbscore('undo', 'tune');
    expect((await sung())[0]).toBe('1:hel/begin');
    await sbscore('lyric', 'set', 'tune', 'bar1.n1', 'la', '--verse', '2');
    expect((await sbscore('lyric', 'rm', 'tune', 'bar1.n1', '--verse', '2')).code).toBe(EXIT.ok);
    expect((await sung())[0]).toBe('1:hel/begin');
    expect((await sbscore('lyric', 'rm', 'tune', 'bar1.n1')).code).toBe(EXIT.ok);
    expect((await sung())[0]).toBe('');
  });

  it('wants a syllable, refuses a bad verse and a second position flag, and removing what is not there', async () => {
    await fourNotes();
    expect((await sbscore('lyric', 'set', 'tune', 'bar1.n1')).code).toBe(EXIT.usage);
    expect((await sbscore('lyric', 'set', 'tune', 'bar1.n1', 'la', '--verse', 'two')).code).toBe(EXIT.usage);
    expect((await sbscore('lyric', 'set', 'tune', 'bar1.n1', 'la', '--begin', '--end')).code).toBe(EXIT.usage);
    expect((await sbscore('lyric', 'set', 'tune', 'bar1.n1', 'la', '--verse', '7')).code).not.toBe(EXIT.ok);
    expect((await sbscore('lyric', 'rm', 'tune', 'bar1.n1')).code).not.toBe(EXIT.ok);
  });
});

describe('sbscore lyrics', () => {
  it('distributes a verse over a bar range as one undoable edit, and refuses too many syllables', async () => {
    await fourNotes();
    expect((await sbscore('lyrics', 'set', 'tune', '1-2', 'Hel-lo my sweet')).code).toBe(EXIT.ok);
    expect(await sung()).toEqual(['1:Hel/begin', '1:lo/end', '1:my/single', '1:sweet/single']);
    expect((await sbscore('lyrics', 'set', 'tune', '2', 'Soft', '--verse', '2')).code).toBe(EXIT.ok);
    expect((await sung())[2]).toBe('1:my/single 2:Soft/single');
    await sbscore('undo', 'tune');
    expect((await sung())[2]).toBe('1:my/single');
    expect((await sbscore('lyrics', 'set', 'tune', '1', 'a b c')).code).not.toBe(EXIT.ok);
    expect((await sbscore('lyrics', 'set', 'tune', 'one-two', 'a')).code).toBe(EXIT.usage);
    expect((await sbscore('lyrics', 'frobnicate', 'tune', '1', 'a')).code).toBe(EXIT.usage);
  });
});
