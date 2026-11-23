import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, silentLogger } from '@sibei/api';
import type { Api, JobStore, ScoreStore } from '@sibei/api';
import { openSqliteJobStore, openSqliteStore } from '@sibei/api/sqlite';
import { scoreToMusicXml } from '@sibei/codec';
import { aabaChart } from '@sibei/fixtures';
import type { Score } from '@sibei/model';

/**
 * MusicXML import over real HTTP (SIB2-152). No OMR worker is configured: a MusicXML file needs none. The
 * boundary is where untrusted bytes are bounded, so the refusals are tested as hard as the success.
 */

let store: ScoreStore;
let jobs: JobStore;
let api: Api;
let base: string;

beforeEach(async () => {
  store = openSqliteStore({ filename: ':memory:' });
  jobs = openSqliteJobStore({ filename: ':memory:' });
  api = createApi({ store, jobs, logger: silentLogger });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
});

afterEach(async () => {
  await api.close();
  await jobs.close();
  await store.close();
});

async function upload(body: string | Uint8Array, type = 'application/vnd.recordare.musicxml+xml') {
  const response = await fetch(`${base}/v1/imports`, { method: 'POST', body: body as BodyInit, headers: { 'content-type': type } });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function settle(id: string): Promise<Record<string, any>> {
  for (let i = 0; i < 200; i++) {
    const job = ((await (await fetch(`${base}/v1/imports/${id}`)).json()) as any).job;
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('did not settle');
}

async function scoreOf(id: string): Promise<Score> {
  return ((await (await fetch(`${base}/v1/scores/${id}`)).json()) as any).score;
}

/** A single-entry-per-name zip, stored with deflate, built by hand: enough for an `.mxl`. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const CONTAINER = (path: string): string =>
  `<?xml version="1.0"?><container><rootfiles><rootfile full-path="${path}"/></rootfiles></container>`;

describe('POST /v1/imports with MusicXML (SIB2-152)', () => {
  it('imports a round-tripped fixture to an editable draft with no worker', async () => {
    const original = aabaChart();
    const created = await upload(scoreToMusicXml(original));
    expect(created.status).toBe(202);
    const job = await settle(created.body.job.id);
    expect(job.status).toBe('succeeded');
    const score = await scoreOf(job.scoreId);
    expect(score.bars).toHaveLength(original.bars.length);
    // A fresh history: exactly one op, the import.
    const history = (await (await fetch(`${base}/v1/scores/${job.scoreId}`)).json()) as any;
    expect(history.version).toBe(1);
  });

  it('keeps what the codec dropped as the job diagnostic', async () => {
    const xml = scoreToMusicXml(aabaChart()).replace(
      '<note>',
      '<direction><direction-type><dynamics><fz/></dynamics></direction-type></direction><note>',
    );
    const job = await settle((await upload(xml)).body.job.id);
    expect(job.status).toBe('succeeded');
    expect(job.diagnostic).toContain('the dynamic <fz> was dropped');
  });

  it('has no scan to show', async () => {
    const job = await settle((await upload(scoreToMusicXml(aabaChart()))).body.job.id);
    const source = (await (await fetch(`${base}/v1/scores/${job.scoreId}/source`)).json()) as any;
    expect(source.imageCount).toBe(0);
  });

  it('reads a compressed .mxl, naming the root file through container.xml', async () => {
    const xml = scoreToMusicXml(aabaChart());
    const mxl = zip({ 'META-INF/container.xml': CONTAINER('tune.musicxml'), 'tune.musicxml': xml });
    const created = await upload(mxl, 'application/vnd.recordare.musicxml');
    expect(created.status).toBe(202);
    expect((await settle(created.body.job.id)).status).toBe('succeeded');
  });

  it('refuses each bad file with its own non-retryable kind, and creates no job', async () => {
    const cases: Array<[string | Uint8Array, string]> = [
      ['not xml', 'invalid-musicxml'],
      ['<html/>', 'invalid-musicxml'],
      ['<score-timewise/>', 'unsupported-musicxml'],
      ['<a>'.repeat(10_000), 'invalid-musicxml'],
      [zip({ 'readme.txt': 'hello' }), 'invalid-musicxml'],
      [Buffer.from('PK\u0003\u0004 not really a zip'), 'invalid-musicxml'],
    ];
    for (const [body, kind] of cases) {
      const reply = await upload(body);
      expect(reply.status).toBe(422);
      expect(reply.body.error.kind).toBe(kind);
    }
    const listed = (await (await fetch(`${base}/v1/imports`)).json()) as any;
    expect(listed.jobs).toEqual([]);
  });

  it('refuses a zip bomb without inflating it past the cap', async () => {
    const bomb = zip({ 'META-INF/container.xml': CONTAINER('big.xml'), 'big.xml': '<a>' + ' '.repeat(40_000_000) });
    const reply = await upload(bomb, 'application/vnd.recordare.musicxml');
    expect(reply.status).toBe(422);
    expect(reply.body.error.kind).toBe('invalid-musicxml');
  });
});
