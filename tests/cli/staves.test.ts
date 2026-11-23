import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Api, ScoreStore } from '@sibei/api';
import { EXIT, run } from '@sibei/cli';
import { allStaves, barViews, formatPitch, notesOf, voiceIndexes } from '@sibei/model';
import type { Score } from '@sibei/model';

/**
 * `sbscore part|staff|voice|clef|instrument` and the `s2.v2.` address qualifier over a real server (ADR-0041
 * section 2, SIB2-226): a two-staff, two-voice score built entirely from the CLI and addressed unambiguously.
 */

let store: ScoreStore;
let api: Api;
let baseUrl: string;

beforeEach(async () => {
  store = openSqliteStore({ filename: ':memory:' });
  api = createApi({ store, logger: { request: () => {}, error: () => {} } });
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
  const code = await run(argv, { baseUrl, io: { out: (t) => out.push(t), err: (t) => err.push(t) } });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function open(): Promise<Score> {
  const opened = await sbscore('open', 'tune', '--json');
  return (JSON.parse(opened.out) as { score: Score }).score;
}

const pitches = (score: Score, select: { staff?: string; voice?: number }): string[] =>
  barViews(score, select).flatMap((bar) => notesOf(bar).map((n) => formatPitch(n.pitch)));

async function build(): Promise<void> {
  await sbscore('new', '--id', 'tune', '--bars', '4');
  const steps = [
    ['staff', 'add', 'tune', 'p1', '--clef', 'bass'],
    ['instrument', 'set', 'tune', '--name', 'Piano', '--instrument', '0'],
    ['voice', 'add', 'tune', 's1'],
    ['note', 'add', 'tune', 's1.v1.bar1.beat1', '--pitch', 'C5', '--dur', '4'],
    ['note', 'add', 'tune', 'bar1.beat1', '--staff', '1', '--voice', '2', '--pitch', 'E4', '--dur', '4'],
    ['note', 'add', 'tune', 'bar1.beat1', '--staff', '2', '--voice', '1', '--pitch', 'C3', '--dur', '2'],
    ['rest', 'add', 'tune', 's2.bar1.beat3', '--dur', '2'],
    ['clef', 'set', 'tune', 's2.bar3', '--clef', 'treble'],
  ];
  for (const argv of steps) {
    const result = await sbscore(...argv);
    expect(result.err, argv.join(' ')).toBe('');
    expect(result.code, argv.join(' ')).toBe(EXIT.ok);
  }
}

describe('building a two-staff, two-voice score from the CLI', () => {
  it('lands every note on the staff and voice its address names', async () => {
    await build();
    const score = await open();
    expect(allStaves(score).map((s) => [s.id, s.clef])).toEqual([['staff-1', 'treble'], ['staff-2', 'bass']]);
    expect(voiceIndexes(allStaves(score)[0]!)).toEqual([1, 2]);
    expect(score.parts[0]!.name).toBe('Piano');
    expect(pitches(score, {})).toEqual(['C5']);
    expect(pitches(score, { staff: 'staff-1', voice: 2 })).toEqual(['E4']);
    expect(pitches(score, { staff: 'staff-2', voice: 1 })).toEqual(['C3']);
    expect(allStaves(score)[1]!.bars[2]!.clef).toBe('treble');
  });

  it('shows the staves and voices, with addresses that work', async () => {
    await build();
    const shown = (await sbscore('show', 'tune')).out;
    expect(shown).toContain('part p1 "Piano" gm0');
    expect(shown).toContain('s2 bass  v1  bar3 treble');
    expect(shown).toMatch(/s1\.v2\n\s+bar1\s+n1 e4\/4/);
    expect(shown).toMatch(/s2\.v1\n\s+bar1\s+n1 c3\/2/);
    const edited = await sbscore('note', 'set', 'tune', 's1.v2.bar1.n1', '--pitch', 'F4');
    expect(edited.code).toBe(EXIT.ok);
    expect(pitches(await open(), { staff: 'staff-1', voice: 2 })).toEqual(['F4']);
  });

  it('refuses an ambiguous address with the address exit code and the candidates', async () => {
    await build();
    const result = await sbscore('note', 'set', 'tune', 'bar1.n1', '--pitch', 'D5');
    expect(result.code).toBe(EXIT.address);
    expect(result.err).toContain('s1.v1.bar1.n1');
    expect(result.err).toContain('s1.v2.bar1.n1');
    expect(result.err).toContain('s2.v1.bar1.n1');
    // Nothing moved.
    expect(pitches(await open(), {})).toEqual(['C5']);
    const missing = await sbscore('note', 'add', 'tune', 's3.bar2.beat1', '--pitch', 'C5', '--dur', '4');
    expect(missing.code).toBe(EXIT.address);
    expect(missing.err).toContain('no staff s3');
  });

  it('refuses --staff on an id, and removal of a staff holding music without --force', async () => {
    await build();
    expect((await sbscore('note', 'rm', 'tune', 'note-1', '--staff', '2')).code).toBe(EXIT.usage);
    const refused = await sbscore('staff', 'rm', 'tune', 's2');
    expect(refused.code).toBe(EXIT.validation);
    expect(refused.err).toContain('force');
    expect((await sbscore('staff', 'rm', 'tune', 's2', '--force')).code).toBe(EXIT.ok);
    expect(allStaves(await open())).toHaveLength(1);
  });

  it('undoes a structure edit', async () => {
    await build();
    expect((await sbscore('voice', 'rm', 'tune', 's1.v2', '--force')).code).toBe(EXIT.ok);
    expect(voiceIndexes(allStaves(await open())[0]!)).toEqual([1]);
    expect((await sbscore('undo', 'tune')).code).toBe(EXIT.ok);
    const back = await open();
    expect(voiceIndexes(allStaves(back)[0]!)).toEqual([1, 2]);
    expect(pitches(back, { staff: 'staff-1', voice: 2 })).toEqual(['E4']);
  });

  it('takes the part verbs', async () => {
    await sbscore('new', '--id', 'tune', '--bars', '2');
    expect((await sbscore('part', 'add', 'tune', '--name', 'Drums', '--staff-type', 'percussion')).code).toBe(EXIT.ok);
    expect((await sbscore('instrument', 'set', 'tune', 'p2', '--transposition', '-2', '--instrument', 'none')).code).toBe(EXIT.ok);
    const score = await open();
    expect(score.parts[1]).toMatchObject({ name: 'Drums', transposition: -2, instrument: null });
    expect(score.parts[1]!.staves[0]).toMatchObject({ type: 'percussion', clef: 'percussion' });
    expect((await sbscore('part', 'rm', 'tune', 'p2')).code).toBe(EXIT.ok);
    expect((await sbscore('part', 'rm', 'tune', 'p1')).code).toBe(EXIT.validation);
  });

  it('writes drums with --drum and --head and prints them by name (SIB2-230)', async () => {
    await sbscore('new', '--id', 'tune', '--bars', '2');
    expect((await sbscore('part', 'add', 'tune', '--name', 'Drums', '--staff-type', 'percussion')).code).toBe(EXIT.ok);
    expect((await sbscore('note', 'add', 'tune', 's2.bar1.beat1', '--drum', 'banjo', '--dur', '4')).code).toBe(EXIT.validation);
    expect((await sbscore('note', 'add', 'tune', 's2.bar1.beat1', '--drum', 'open hi-hat', '--dur', '4')).code).toBe(EXIT.ok);
    expect((await sbscore('note', 'add', 'tune', 's2.bar1.beat2', '--drum', 'kick', '--head', 'diamond', '--dur', '4')).code).toBe(EXIT.ok);
    expect((await sbscore('note', 'add', 'tune', 's1.bar1.beat1', '--pitch', 'C5', '--dur', '4', '--head', 'x')).code).toBe(EXIT.validation);
    const shown = await sbscore('show', 'tune');
    expect(shown.out).toContain('hihat-open/4');
    expect(shown.out).toContain('kick/4:diamond');
    expect((await sbscore('note', 'set', 'tune', 's2.bar1.n2', '--head', 'default')).code).toBe(EXIT.ok);
    expect((await sbscore('show', 'tune')).out).not.toContain(':diamond');
  });
});
