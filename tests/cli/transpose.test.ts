import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Api, ScoreStore } from '@sibei/api';
import { EXIT, run } from '@sibei/cli';

/**
 * `sbscore transpose <id> --to <key>` over a real server (V6, ADR-0016). The applier owns the
 * transposition; this asserts the CLI reaches it and that the change is a real, persisted mutation —
 * the concert key moves, the melody and chords move with it, and `open` reads it back.
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

const json = <T>(text: string): T => JSON.parse(text) as T;

interface Document {
  score: {
    meta: { key: { tonic: string; alter: number; mode: string } };
    bars: { number: number; items: { kind: string; pitch?: { step: string; alter: number; octave: number } }[]; chords: { text: string }[] }[];
  };
}

async function aChartInC(): Promise<void> {
  await sbscore('new', '--id', 'tune', '--title', 'Test', '--key', 'C', '--bars', '4');
  await sbscore('note', 'add', 'tune', 'bar1.beat1', '--pitch', 'G4', '--dur', '4');
  await sbscore('note', 'add', 'tune', 'bar1.beat2', '--pitch', 'F4', '--dur', '4');
  await sbscore('chord', 'set', 'tune', 'bar1.beat1', '--text', 'C7');
  await sbscore('chord', 'set', 'tune', 'bar1.beat3', '--text', 'G7');
}

describe('sbscore transpose', () => {
  it('changes the concert key and moves the melody and chords, read back through open', async () => {
    await aChartInC();
    const result = await sbscore('transpose', 'tune', '--to', 'Eb');
    expect(result.code).toBe(EXIT.ok);

    const document = json<Document>((await sbscore('open', 'tune')).out);
    expect(document.score.meta.key).toEqual({ tonic: 'E', alter: -1, mode: 'major' });

    const bar1 = document.score.bars.find((b) => b.number === 1)!;
    const pitches = bar1.items
      .filter((i) => i.kind === 'note')
      .map((i) => `${i.pitch!.step}${i.pitch!.alter === -1 ? 'b' : i.pitch!.alter === 1 ? '#' : ''}${i.pitch!.octave}`);
    // G4 and F4 up a minor third are Bb4 and Ab4 — flats, never A#/G#.
    expect(pitches).toEqual(['Bb4', 'Ab4']);
    expect(bar1.chords.map((c) => c.text)).toEqual(['Eb7', 'Bb7']);
  });

  it('rejects a bad key with a usage error, changing nothing', async () => {
    await aChartInC();
    const result = await sbscore('transpose', 'tune', '--to', 'H');
    expect(result.code).toBe(EXIT.usage);

    const document = json<Document>((await sbscore('open', 'tune')).out);
    expect(document.score.meta.key).toEqual({ tonic: 'C', alter: 0, mode: 'major' });
  });

  it('needs a --to key', async () => {
    await aChartInC();
    const result = await sbscore('transpose', 'tune');
    expect(result.code).toBe(EXIT.usage);
  });
});
