import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, silentLogger } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Api, ScoreStore } from '@sibei/api';
import { EXIT, run } from '@sibei/cli';

/** `sbscore group <id> <count>` (SIB2-282, the ADR-0003 amendment), against a real server over HTTP. */

let store: ScoreStore;
let api: Api;
let baseUrl: string;

beforeEach(async () => {
  store = openSqliteStore({ filename: ':memory:' });
  api = createApi({ store, logger: silentLogger });
  const { port } = await api.listen(0);
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await api.close();
  await store.close();
});

async function sbscore(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { baseUrl, io: { out: (text) => out.push(text), err: (text) => err.push(text) } });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function chartWithNotes(howMany: number): Promise<void> {
  await sbscore('new', '--id', 'g', '--title', 'G', '--key', 'C', '--bars', '4');
  for (let beat = 1; beat <= howMany; beat += 1) await sbscore('note', 'add', 'g', `bar1.beat${beat}`, '--pitch', 'C5', '--dur', '4');
}

const noteCount = async (): Promise<number> => ((await sbscore('show', 'g')).out.match(/c5\/4/g) ?? []).length;

describe('sbscore group', () => {
  it('folds the last n edits so one undo reverses them all and one redo restores them', async () => {
    await chartWithNotes(4);
    const grouped = await sbscore('group', 'g', '4');
    expect(grouped.code).toBe(EXIT.ok);
    expect(grouped.out).toMatch(/^grouped 4 edits/);
    expect(await noteCount()).toBe(4);
    expect((await sbscore('undo', 'g')).code).toBe(EXIT.ok);
    expect(await noteCount()).toBe(0);
    expect((await sbscore('redo', 'g')).code).toBe(EXIT.ok);
    expect(await noteCount()).toBe(4);
  });

  it('prints the wire result with --json', async () => {
    await chartWithNotes(3);
    const result = await sbscore('group', 'g', '3', '--json');
    expect(JSON.parse(result.out)).toMatchObject({ scoreId: 'g', moved: true, canUndo: true });
  });

  it('refuses a count that is not a whole number of 2 or more, or that reaches the create', async () => {
    await chartWithNotes(2);
    expect((await sbscore('group', 'g', '1')).code).toBe(EXIT.usage);
    expect((await sbscore('group', 'g', 'many')).code).toBe(EXIT.usage);
    expect((await sbscore('group', 'g')).code).toBe(EXIT.usage);
    const tooMany = await sbscore('group', 'g', '3');
    expect(tooMany.code).not.toBe(EXIT.ok);
    expect(await noteCount()).toBe(2);
  });
});
