import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Api, ScoreStore } from '@sibei/api';
import { EXIT, run } from '@sibei/cli';
import { barViews, formatPitch, notesOf } from '@sibei/model';
import type { Score } from '@sibei/model';

/** `sbscore range copy|paste|clear` over a real server (SIB2-279, Q79): copy a span, paste it elsewhere, clear bars. */

let store: ScoreStore;
let api: Api;
let baseUrl: string;
let dir: string;

beforeEach(async () => {
  store = openSqliteStore({ filename: ':memory:' });
  api = createApi({ store, logger: { request: () => {}, error: () => {} } });
  const { port } = await api.listen(0);
  baseUrl = `http://127.0.0.1:${port}`;
  dir = mkdtempSync(join(tmpdir(), 'range-'));
});

afterEach(async () => {
  await api.close();
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function sbscore(argv: string[], stdin = ''): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { baseUrl, readStdin: async () => stdin, io: { out: (t) => out.push(t), err: (t) => err.push(t) } });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function open(): Promise<Score> {
  const opened = await sbscore(['open', 'tune']);
  return (JSON.parse(opened.out) as { score: Score }).score;
}

const bar = (score: Score, number: number): string[] =>
  notesOf(barViews(score).find((view) => view.number === number)!).map((n) => `${formatPitch(n.pitch)}/${n.duration.value}`);

describe('sbscore range', () => {
  it('copies a span to a file, pastes it two bars later, and clears bars, each one undoable', async () => {
    await sbscore(['new', '--id', 'tune', '--bars', '4']);
    for (const [at, pitch] of [['bar1.beat1', 'C5'], ['bar1.beat2', 'D5'], ['bar2.beat1', 'E5']]) {
      expect((await sbscore(['note', 'add', 'tune', at!, '--pitch', pitch!, '--dur', '4'])).code).toBe(EXIT.ok);
    }
    await sbscore(['chord', 'set', 'tune', 'bar1.beat1', '--text', 'Cmaj7']);

    const file = join(dir, 'clip.json');
    const copied = await sbscore(['range', 'copy', 'tune', '1-2', '--out', file]);
    expect(copied.code).toBe(EXIT.ok);
    const clip = JSON.parse(readFileSync(file, 'utf8')) as { format: string; ticks: number };
    expect(clip.format).toBe('sibei-clip');
    expect(clip.ticks).toBe(3840);

    const pasted = await sbscore(['range', 'paste', 'tune', 'bar3.beat1', '--clip', file]);
    expect(pasted.code).toBe(EXIT.ok);
    const after = await open();
    expect(bar(after, 3)).toEqual(['C5/4', 'D5/4']);
    expect(bar(after, 4)).toEqual(['E5/4']);
    expect(barViews(after).find((view) => view.number === 3)!.chords.map((chord) => chord.text)).toEqual(['Cmaj7']);

    // Stdin works too, and a paste past the end names the fix.
    const tooFar = await sbscore(['range', 'paste', 'tune', 'bar4.beat1', '--clip', '-'], readFileSync(file, 'utf8'));
    expect(tooFar.code).not.toBe(EXIT.ok);
    expect(tooFar.err).toMatch(/bar add/);

    expect((await sbscore(['range', 'clear', 'tune', '3-4', '--harmony'])).code).toBe(EXIT.ok);
    const cleared = await open();
    expect(bar(cleared, 3)).toEqual([]);
    expect(barViews(cleared).find((view) => view.number === 3)!.chords).toEqual([]);

    // One undo each.
    await sbscore(['undo', 'tune']);
    expect(bar(await open(), 3)).toEqual(['C5/4', 'D5/4']);
    await sbscore(['undo', 'tune']);
    expect(bar(await open(), 3)).toEqual([]);
  });

  it('refuses a clip that is not one', async () => {
    await sbscore(['new', '--id', 'tune', '--bars', '2']);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"hello":1}');
    const result = await sbscore(['range', 'paste', 'tune', 'bar1.beat1', '--clip', bad]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toMatch(/not a clip/);
    expect((await sbscore(['range', 'frob', 'tune'])).code).toBe(EXIT.usage);
  });
});
