import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Api, RequestLine, ScoreStore } from '@sibei/api';
import { EXIT, run } from '@sibei/cli';

/**
 * The CLI, against a real server over real HTTP.
 *
 * `run` returns an exit code rather than calling `process.exit`, so the whole surface is drivable
 * in-process — one server, many commands, no subprocess per assertion. The exit codes are *also*
 * checked through a real subprocess in `tests/e2e/cli-demo.test.ts`, because a number returned from a
 * function is not the contract; a number the shell sees is.
 */

let store: ScoreStore;
let api: Api;
let baseUrl: string;
let out: string[];
let err: string[];
/** Every request the server saw, so "which calls did the CLI make" can be an assertion. */
let requests: RequestLine[];

beforeEach(async () => {
  store = openSqliteStore({ filename: ':memory:' });
  requests = [];
  api = createApi({
    store,
    logger: { request: (line) => void requests.push(line), error: () => {} },
  });
  const { port } = await api.listen(0);
  baseUrl = `http://127.0.0.1:${port}`;
  out = [];
  err = [];
});

afterEach(async () => {
  await api.close();
  store.close();
});

/** One command. Returns the exit code and whatever it printed. */
async function sbscore(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  out = [];
  err = [];
  requests = [];
  const code = await run(argv, {
    baseUrl,
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const json = <T>(text: string): T => JSON.parse(text) as T;

async function aChart(): Promise<void> {
  await sbscore('new', '--id', 'soul', '--title', 'Body and Soul', '--composer', 'Johnny Green', '--key', 'Db', '--bars', '8');
}

describe('the library verbs', () => {
  it('creates a chart', async () => {
    const result = await sbscore('new', '--id', 'soul', '--title', 'Body and Soul');
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toBe('soul  version 1');
  });

  it('makes up an id when none is given, so `sbscore new` alone works', async () => {
    const result = await sbscore('new', '--json');
    expect(result.code).toBe(EXIT.ok);
    expect(json<{ scoreId: string }>(result.out).scoreId).toMatch(/^score-\d{14}$/);
  });

  it('lists what is there, and says so plainly when nothing is', async () => {
    expect((await sbscore('list')).out).toContain('no charts yet');
    await aChart();
    expect((await sbscore('list')).out).toBe('soul  v1  Db  Body and Soul  Johnny Green');
  });

  it('opens the full structured dump, which is where anything the projection drops lives', async () => {
    await aChart();
    const result = await sbscore('open', 'soul');
    const document = json<{ score: { meta: { title: string }; bars: unknown[] } }>(result.out);
    expect(document.score.meta.title).toBe('Body and Soul');
    expect(document.score.bars).toHaveLength(8);
  });

  it('removes', async () => {
    await aChart();
    expect((await sbscore('rm', 'soul')).out).toBe('removed soul');
    expect((await sbscore('show', 'soul')).code).toBe(EXIT.notFound);
  });

  it('sets metadata, and can clear the style line', async () => {
    await aChart();
    await sbscore('meta', 'set', 'soul', '--style', 'Ballad');
    expect((await sbscore('show', 'soul')).out).toContain('— Ballad');
    await sbscore('meta', 'set', 'soul', '--style', '');
    expect((await sbscore('show', 'soul')).out).not.toContain('— Ballad');
  });
});

describe('editing', () => {
  it('adds, edits and removes a note by position', async () => {
    await aChart();
    expect((await sbscore('note', 'add', 'soul', 'bar1.beat1', '--pitch', 'Db5', '--dur', '8')).code).toBe(EXIT.ok);
    expect((await sbscore('show', 'soul')).out).toContain('n1 db5/8');

    await sbscore('note', 'set', 'soul', 'bar1.beat1', '--pitch', 'C5', '--dur', '4');
    expect((await sbscore('show', 'soul')).out).toContain('n1 c5/4');

    await sbscore('note', 'rm', 'soul', 'bar1.beat1');
    expect((await sbscore('show', 'soul')).out).not.toContain('c5/4');
  });

  it('takes an ordinal address and an id as readily as a beat', async () => {
    await aChart();
    await sbscore('note', 'add', 'soul', 'bar1.beat1', '--pitch', 'Db5', '--dur', '4');
    await sbscore('note', 'set', 'soul', 'bar1.n1', '--pitch', 'Eb5');
    expect((await sbscore('show', 'soul')).out).toContain('n1 eb5/4');
    await sbscore('note', 'set', 'soul', 'note-1', '--pitch', 'F5');
    expect((await sbscore('show', 'soul')).out).toContain('n1 f5/4');
  });

  it('adds and removes a rest', async () => {
    await aChart();
    expect((await sbscore('rest', 'add', 'soul', 'bar1.beat2', '--dur', '4')).code).toBe(EXIT.ok);
    expect((await sbscore('show', 'soul')).out).toContain('n1 r/4');
    expect((await sbscore('rest', 'rm', 'soul', 'bar1.beat2')).code).toBe(EXIT.ok);
  });

  it('takes a dotted duration in the same spelling the projection prints', async () => {
    // Reading a projection is how an agent learns to write a command, so `--dur 2.` and `g5/2.` had
    // better be the same notation.
    await aChart();
    await sbscore('note', 'add', 'soul', 'bar1.beat1', '--pitch', 'G5', '--dur', '2.');
    expect((await sbscore('show', 'soul')).out).toContain('n1 g5/2.');
  });

  it('sets a tie', async () => {
    await aChart();
    await sbscore('note', 'add', 'soul', 'bar1.beat1', '--pitch', 'G5', '--dur', '1', '--tie', 'start');
    expect((await sbscore('show', 'soul')).out).toContain('n1 g5/1~');
  });
});

describe('a write always names the version it expects (ADR-0003, KAN-607)', () => {
  it('reads the version first when --if-version is absent, instead of writing blind', async () => {
    // The server refuses a write that names no version, and `--if-version` is optional — so absence
    // has to mean read-modify-write rather than "apply against whatever it is now". The GET is how
    // that is visible from out here: no read, and the POST could only have omitted the field.
    await aChart();
    const result = await sbscore('note', 'add', 'soul', 'bar1.beat1', '--pitch', 'Db5', '--dur', '4');
    expect(result.code).toBe(EXIT.ok);
    expect(requests.map((line) => `${line.method} ${line.path} ${line.status}`)).toEqual([
      'GET /v1/scores/soul 200',
      'POST /v1/scores/soul/ops 200',
    ]);
  });

  it('takes the caller at their word when --if-version is given, and reads nothing', async () => {
    await aChart();
    const result = await sbscore('note', 'add', 'soul', 'bar1.beat1', '--pitch', 'Db5', '--dur', '4', '--if-version', '1');
    expect(result.code).toBe(EXIT.ok);
    expect(requests.map((line) => line.method)).toEqual(['POST']);
  });

  it('still reports a score that is not there as 5, wherever it noticed', async () => {
    // The read now happens first, so this exit code comes off the GET rather than the POST. Same
    // number, same message, and it is the number that is the contract (ADR-0008).
    const result = await sbscore('note', 'add', 'nope', 'bar1.beat1', '--pitch', 'Db5', '--dur', '4');
    expect(result.code).toBe(EXIT.notFound);
    expect(result.err).toContain('there is no score with the id "nope"');
  });

  it('batch names one too, so the transactional verb is not the blind one', async () => {
    await aChart();
    const ops = JSON.stringify([
      { type: 'note.add', target: 'bar1.beat1', payload: { pitch: 'Db5', duration: { value: 8, dots: 0 } } },
      { type: 'meta.set', payload: { style: 'Ballad' } },
    ]);
    const result = await sbscore('batch', 'soul', '--ops', ops);
    expect(result.code).toBe(EXIT.ok);
    expect(requests.map((line) => line.method)).toEqual(['GET', 'POST']);
  });
});

describe('the exit codes are distinct enough to branch on (ADR-0008)', () => {
  it('0 for success', async () => {
    expect((await sbscore('new', '--id', 'soul')).code).toBe(EXIT.ok);
  });

  it('1 for usage', async () => {
    expect((await sbscore('nonsense')).code).toBe(EXIT.usage);
    // A flag with nothing after it fails in the argument parser, which used to run *outside* the
    // handler — so it threw out of `run` and reached the shell as a stack trace rather than as an
    // exit code. Found by V3d's `-o` with no path after it, which is the same shape.
    expect((await sbscore('new', '--title')).code).toBe(EXIT.usage);
    expect((await sbscore('note', 'add')).code).toBe(EXIT.usage);
    expect((await sbscore('note', 'sideways', 'soul', 'bar1.beat1')).code).toBe(EXIT.usage);
    expect((await sbscore()).code).toBe(EXIT.usage);
  });

  it('2 for a validation failure', async () => {
    await aChart();
    const result = await sbscore('note', 'add', 'soul', 'bar1.beat1', '--pitch', 'H9', '--dur', '4');
    expect(result.code).toBe(EXIT.validation);
    expect(result.err).toContain('is not a pitch');
  });

  it('3 for a bad address, with the bar’s real onsets in the message', async () => {
    await aChart();
    await sbscore('note', 'add', 'soul', 'bar1.beat1', '--pitch', 'Db5', '--dur', '4');
    const result = await sbscore('note', 'set', 'soul', 'bar1.beat3', '--pitch', 'C5');
    expect(result.code).toBe(EXIT.address);
    expect(result.err).toContain('bar 1 has no note at beat 3; onsets are 1');
  });

  it('4 for a stale-version conflict, with the version to retry at', async () => {
    await aChart();
    await sbscore('note', 'add', 'soul', 'bar1.beat1', '--pitch', 'Db5', '--dur', '4');
    const result = await sbscore('note', 'set', 'soul', 'bar1.n1', '--pitch', 'C5', '--if-version', '1');
    expect(result.code).toBe(EXIT.conflict);
    expect(result.err).toMatch(/the score is at version 2, not 1/);
  });

  it('5 for a score that is not there', async () => {
    expect((await sbscore('show', 'nope')).code).toBe(EXIT.notFound);
    expect((await sbscore('rm', 'nope')).code).toBe(EXIT.notFound);
  });

  it('6 when the server is not running, which a file-editing CLI would not have needed', async () => {
    const result = await run(['list'], {
      baseUrl: 'http://127.0.0.1:1',
      io: { out: (text) => out.push(text), err: (text) => err.push(text) },
    });
    expect(result).toBe(EXIT.noServer);
    expect(err.join('')).toContain('sbscore serve');
  });

  it('8 for an id that is taken', async () => {
    await aChart();
    expect((await sbscore('new', '--id', 'soul')).code).toBe(EXIT.exists);
  });
});

describe('--json everywhere, because an agent should never parse prose', () => {
  it('on every verb that prints something', async () => {
    await aChart();
    await sbscore('note', 'add', 'soul', 'bar1.beat1', '--pitch', 'Db5', '--dur', '4');

    for (const argv of [
      ['list', '--json'],
      ['show', 'soul', '--json'],
      ['note', 'set', 'soul', 'bar1.n1', '--pitch', 'C5', '--json'],
      ['meta', 'set', 'soul', '--title', 'Renamed', '--json'],
      ['rm', 'soul', '--json'],
    ]) {
      const result = await sbscore(...argv);
      expect(result.code).toBe(EXIT.ok);
      expect(() => json(result.out)).not.toThrow();
    }
  });

  it('on errors too, flat rather than nested', async () => {
    // The first version wrapped the server's whole error object, so --json came back with
    // detail.detail.detail and an agent had to dig three levels for the onsets.
    await aChart();
    await sbscore('note', 'add', 'soul', 'bar1.beat1', '--pitch', 'Db5', '--dur', '4');
    const result = await sbscore('note', 'set', 'soul', 'bar1.beat3', '--pitch', 'C5', '--json');

    const failure = json<{ error: { kind: string; detail: { failure: { onsets: number[] } } } }>(result.err);
    expect(failure.error.kind).toBe('address');
    expect(failure.error.detail.failure.onsets).toEqual([1]);
  });

  it('puts the version to retry at at the top level of a conflict', async () => {
    await aChart();
    const result = await sbscore('meta', 'set', 'soul', '--title', 'X', '--if-version', '99', '--json');
    const failure = json<{ error: { kind: string; currentVersion: number } }>(result.err);
    expect(failure.error).toMatchObject({ kind: 'stale-version', currentVersion: 1 });
  });

  it('never prints a mixture of prose and JSON', async () => {
    await aChart();
    const result = await sbscore('show', 'soul', '--json');
    expect(result.out.startsWith('{')).toBe(true);
    expect(result.err).toBe('');
  });
});

describe('batch is a transactional op list (ADR-0008)', () => {
  const ops = JSON.stringify([
    { type: 'note.add', target: 'bar1.beat1', payload: { pitch: 'Db5', duration: { value: 4, dots: 0 } } },
    { type: 'note.add', target: 'bar1.beat2', payload: { pitch: 'Eb5', duration: { value: 4, dots: 0 } } },
  ]);

  it('applies the whole list as one version bump', async () => {
    await aChart();
    const result = await sbscore('batch', 'soul', '--ops', ops, '--json');
    expect(json<{ version: number; changed: string[] }>(result.out)).toMatchObject({
      version: 2,
      changed: ['note-1', 'note-2'],
    });
  });

  it('applies none of it when one operation is invalid', async () => {
    await aChart();
    await sbscore('note', 'add', 'soul', 'bar1.beat1', '--pitch', 'C5', '--dur', '4');
    const before = (await sbscore('show', 'soul')).out;

    const result = await sbscore('batch', 'soul', '--ops', ops);
    expect(result.code).toBe(EXIT.validation);
    expect(result.err).toContain('operation 1');
    expect((await sbscore('show', 'soul')).out).toBe(before);
  });

  it('rejects --ops that is not a JSON array', async () => {
    await aChart();
    expect((await sbscore('batch', 'soul', '--ops', '{not json')).code).toBe(EXIT.usage);
    expect((await sbscore('batch', 'soul', '--ops', '{"type":"note.rm"}')).code).toBe(EXIT.usage);
  });
});

describe('the demo (SLICES.md, V2)', () => {
  it('authors a chart entirely from the CLI and shows it with every note at its address', async () => {
    await sbscore('new', '--id', 'soul', '--title', 'Body and Soul', '--composer', 'Johnny Green', '--key', 'Db', '--bars', '8');

    // A phrase, note by note, exactly as a human or an agent would type it.
    const written: [string, string, string][] = [
      ['bar1.beat1', 'Db5', '8'],
      ['bar1.beat1.5', 'Eb5', '8'],
      ['bar1.beat2', 'F5', '4'],
      ['bar1.beat3', 'Gb5', '2'],
      ['bar2.beat1', 'F5', '4'],
    ];
    for (const [address, pitch, duration] of written) {
      const result = await sbscore('note', 'add', 'soul', address, '--pitch', pitch, '--dur', duration);
      expect(result.code).toBe(EXIT.ok);
    }
    await sbscore('rest', 'add', 'soul', 'bar2.beat2', '--dur', '4');

    const projection = (await sbscore('show', 'soul')).out;

    // Every note is at the address it was created at. That is the round-trip the test plan asks for.
    expect(projection).toContain('n1 db5/8  n2 eb5/8  n3 f5/4  n4 gb5/2');
    expect(projection).toContain('n1 f5/4  n2 r/4');
    expect(projection).toContain('Body and Soul — Johnny Green — key Db, 4/4, 8 bars');
    // And bar 2 is short, so it is flagged rather than repaired or refused (ADR-0013).
    expect(projection).toMatch(/bar2!/);
  });

  it('then runs the same note set twice, and the second fails with exit 4 and the version', async () => {
    await aChart();
    await sbscore('note', 'add', 'soul', 'bar1.beat1', '--pitch', 'Db5', '--dur', '4');
    const at = json<{ version: number }>((await sbscore('show', 'soul', '--json')).out).version;

    const first = await sbscore('note', 'set', 'soul', 'bar1.n1', '--pitch', 'C5', '--if-version', String(at));
    expect(first.code).toBe(EXIT.ok);

    const second = await sbscore('note', 'set', 'soul', 'bar1.n1', '--pitch', 'B4', '--if-version', String(at));
    expect(second.code).toBe(4);
    expect(second.err).toContain(`the score is at version ${at + 1}, not ${at}`);

    // And the first client's edit survived, which is why the check exists at all.
    expect((await sbscore('show', 'soul')).out).toContain('n1 c5/4');
  });

  it('addressing a beat that is not an onset lists that bar’s real onsets', async () => {
    await aChart();
    await sbscore('note', 'add', 'soul', 'bar1.beat1', '--pitch', 'Db5', '--dur', '8');
    await sbscore('note', 'add', 'soul', 'bar1.beat1.5', '--pitch', 'Eb5', '--dur', '8');
    await sbscore('note', 'add', 'soul', 'bar1.beat4', '--pitch', 'F5', '--dur', '4');

    const result = await sbscore('note', 'set', 'soul', 'bar1.beat3', '--pitch', 'C5');
    expect(result.code).toBe(EXIT.address);
    expect(result.err).toContain('onsets are 1, 1.5, 4');
  });
});

describe('there is no second write path (ADR-0002)', () => {
  it('every editing verb goes through the API, so a stopped server means no edit at all', async () => {
    // The structural guarantee, from the CLI's side: it holds no store and cannot write to one. With
    // the server down, nothing it can be asked to do changes a score.
    //
    // `export` is in the list for the render side of the same argument (V3d): the CLI holds no
    // renderer either, so with the server down it cannot produce a page rather than producing one
    // that might disagree with the server's.
    await aChart();
    await api.close();

    for (const argv of [
      ['note', 'add', 'soul', 'bar1.beat1', '--pitch', 'C5', '--dur', '4'],
      ['note', 'rm', 'soul', 'bar1.n1'],
      ['meta', 'set', 'soul', '--title', 'X'],
      ['rm', 'soul'],
      ['batch', 'soul', '--ops', '[]'],
      ['export', 'soul'],
    ]) {
      expect((await sbscore(...argv)).code).toBe(EXIT.noServer);
    }

    // The store still holds exactly what it held.
    expect(store.get('local', 'soul')?.version).toBe(1);
  });
});

describe('help', () => {
  it('prints the address forms and the exit codes, because those are the contract', async () => {
    const result = await sbscore('--help');
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain('bar12.beat3');
    expect(result.out).toContain('bar12.n3');
    expect(result.out).toContain('note-17');
    expect(result.out).toContain('4 stale-version conflict');
    // --if-version was undocumented until KAN-607, while the demo used it and the exit code it
    // produces was already in the list above. It is the only way to pin a version, so it is part of
    // the same contract.
    expect(result.out).toContain('--if-version N');
  });

  it('lists every verb, and says where an export lands when -o is absent', async () => {
    // The verb list is part of the contract, and a program that writes a file somewhere the caller
    // has to guess is a program nobody trusts.
    const result = await sbscore('--help');
    expect(result.out).toContain('sbscore export <id>');
    expect(result.out).toContain('./Body and Soul.pdf');
  });

  it('prints usage and exits non-zero when given nothing', async () => {
    const result = await sbscore();
    expect(result.code).toBe(EXIT.usage);
    expect(result.out).toContain('sbscore serve');
  });
});
