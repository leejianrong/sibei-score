import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, silentLogger } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Api, ScoreStore } from '@sibei/api';
import { EXIT, run } from '@sibei/cli';

/**
 * `sbscore audio …` over a real server with no audio worker (SIB2-137): the verbs reach the same routes
 * the browser does, and a job simply waits `queued`.
 */

let store: ScoreStore;
let api: Api;
let baseUrl: string;
let dir: string;

beforeEach(async () => {
  store = openSqliteStore({ filename: ':memory:' });
  api = createApi({ store, logger: silentLogger });
  baseUrl = `http://127.0.0.1:${(await api.listen(0)).port}`;
  dir = mkdtempSync(join(tmpdir(), 'sbscore-audio-'));
});
afterEach(async () => {
  await api.close();
  await store.close();
});

async function sbscore(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { baseUrl, cwd: dir, io: { out: (t) => out.push(t), err: (t) => err.push(t) } });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('sbscore audio', () => {
  it('submits a file, lists it, shows it, and removes it', async () => {
    writeFileSync(join(dir, 'take.wav'), Buffer.alloc(64, 7));
    const submitted = await sbscore('audio', 'submit', 'take.wav', '--instrument', 'piano', '--json');
    expect(submitted.code).toBe(EXIT.ok);
    const job = (JSON.parse(submitted.out) as { job: { id: string; status: string; instrument: string } }).job;
    expect(job).toMatchObject({ status: 'queued', instrument: 'piano' });

    expect((await sbscore('audio', 'list')).out).toContain(`${job.id}  queued  take.wav`);
    expect((await sbscore('audio', 'show', job.id)).out).toContain('queued');
    expect((await sbscore('audio', 'rm', job.id)).code).toBe(EXIT.ok);
    expect((await sbscore('audio', 'show', job.id)).code).toBe(EXIT.notFound);
  });

  it('says what is wrong with a file that is not audio, and exits as a validation failure', async () => {
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    const result = await sbscore('audio', 'submit', 'notes.txt');
    expect(result.code).toBe(EXIT.validation);
    expect(result.err).toContain('not an audio type');
  });

  it('refuses retrying a job that has not failed', async () => {
    writeFileSync(join(dir, 'take.wav'), Buffer.alloc(8));
    const { out } = await sbscore('audio', 'submit', 'take.wav', '--json');
    const id = (JSON.parse(out) as { job: { id: string } }).job.id;
    expect((await sbscore('audio', 'retry', id)).code).toBe(EXIT.validation);
  });
});
