import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Api, ScoreStore } from '@sibei/api';
import { EXIT, run } from '@sibei/cli';
import type { Score } from '@sibei/model';

/** `sbscore new --instrument piano --instrument bass --instrument drums` over a real server (SIB2-288), and the name verbs (SIB2-286). */

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

async function open(id: string): Promise<Score> {
  return (JSON.parse((await sbscore('open', id, '--json')).out) as { score: Score }).score;
}

describe('sbscore new --instrument', () => {
  it('builds the parts, staves, programs and transpositions in the order given', async () => {
    const made = await sbscore('new', '--id', 'band', '--bars', '8', '--instrument', 'trumpet-bb', '--instrument', 'piano', '--instrument', 'bass', '--instrument', 'drums');
    expect(made.code).toBe(EXIT.ok);
    const score = await open('band');
    expect(score.parts.map((part) => [part.name, part.instrument, part.transposition, part.staves.length])).toEqual([
      ['Trumpet in Bb', 56, 2, 1],
      ['Piano', 0, 0, 2],
      ['Bass', 32, 0, 1],
      ['Drum Kit', null, 0, 1],
    ]);
    expect(score.parts[3]!.staves[0]).toMatchObject({ type: 'percussion', clef: 'percussion' });
    expect(score.meta).toMatchObject({ layout: 'score', showInstrumentNames: true });
    expect((await sbscore('show', 'band')).out).toContain('part p2 "Piano" short "Pno." gm0');
  });

  it('refuses an unknown preset with the list, as a validation error', async () => {
    const refused = await sbscore('new', '--id', 'x', '--instrument', 'banjo');
    expect(refused.code).not.toBe(EXIT.ok);
    expect(refused.err).toMatch(/unknown instrument "banjo".*piano/);
  });

  it('without --instrument the chart is the plain lead sheet', async () => {
    await sbscore('new', '--id', 'plain');
    const score = await open('plain');
    expect(score.parts).toHaveLength(1);
    expect(score.meta.layout).toBeUndefined();
  });
});

describe('sbscore instrument set --short-name, meta set --instrument-names', () => {
  it('names a part, abbreviates it and toggles the names', async () => {
    await sbscore('new', '--id', 'tune');
    expect((await sbscore('instrument', 'set', 'tune', '--name', 'Piano', '--short-name', 'Pno.')).code).toBe(EXIT.ok);
    expect((await sbscore('meta', 'set', 'tune', '--instrument-names', 'on')).code).toBe(EXIT.ok);
    let score = await open('tune');
    expect(score.parts[0]).toMatchObject({ name: 'Piano', shortName: 'Pno.' });
    expect(score.meta.showInstrumentNames).toBe(true);
    await sbscore('instrument', 'set', 'tune', '--short-name', '');
    await sbscore('meta', 'set', 'tune', '--instrument-names', 'off');
    score = await open('tune');
    expect(score.parts[0]!.shortName).toBeUndefined();
    expect(score.meta.showInstrumentNames).toBeUndefined();
    expect((await sbscore('meta', 'set', 'tune', '--instrument-names', 'maybe')).code).toBe(EXIT.usage);
  });
});
