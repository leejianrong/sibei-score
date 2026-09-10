import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Api, ScoreStore } from '@sibei/api';
import { EXIT, run } from '@sibei/cli';
import { planSystems } from '@sibei/layout';
import type { Score } from '@sibei/model';

/**
 * `sbscore section set/rm <id> <bar>` over a real server (V7, ADR-0021). The applier owns the
 * section; this asserts the CLI reaches it, that it is a real persisted mutation read back through
 * `open`, and — the integration case in the V7 test plan — that **setting a section via the CLI
 * changes the layout the browser renders**. The browser renders through `planSystems` + `layout`,
 * the one render path (ADR-0014), so asserting the system shape changes is asserting exactly that.
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

interface Document {
  score: Score;
}

/** The score as the browser would fetch it, then the systems it would lay out. */
async function systemShape(): Promise<number[]> {
  const opened = await sbscore('open', 'tune', '--json');
  const { score } = JSON.parse(opened.out) as Document;
  return planSystems(score).map((system) => system.bars.length);
}

describe('sbscore section', () => {
  it('sets a section that open reads back, keyed by its start bar', async () => {
    await sbscore('new', '--id', 'tune', '--bars', '8');
    const result = await sbscore('section', 'set', 'tune', 'bar5', '--letter', 'B', '--name', 'Bridge');
    expect(result.code).toBe(EXIT.ok);

    const opened = await sbscore('open', 'tune', '--json');
    const { score } = JSON.parse(opened.out) as Document;
    expect(score.sections).toEqual([{ id: 'section-1', startBar: 5, letter: 'B', name: 'Bridge' }]);
  });

  it('changes the layout the browser renders (the V7 integration case)', async () => {
    await sbscore('new', '--id', 'tune', '--bars', '8');
    // Eight bars with no sections lay out four to a line.
    expect(await systemShape()).toEqual([4, 4]);

    // A section on bar 3 forces a break there: 2 / 4 / 2.
    await sbscore('section', 'set', 'tune', 'bar3', '--letter', 'A');
    expect(await systemShape()).toEqual([2, 4, 2]);

    // Removing it puts the four-bar grid back.
    await sbscore('section', 'rm', 'tune', 'bar3');
    expect(await systemShape()).toEqual([4, 4]);
  });

  it('rejects a bar that does not exist with the bad-address exit code', async () => {
    await sbscore('new', '--id', 'tune', '--bars', '4');
    const result = await sbscore('section', 'set', 'tune', 'bar9', '--letter', 'A');
    expect(result.code).toBe(EXIT.address);
    expect(result.err).toMatch(/no bar 9/);
  });

  it('rejects a position address where a bar was wanted', async () => {
    await sbscore('new', '--id', 'tune', '--bars', '4');
    const result = await sbscore('section', 'set', 'tune', 'bar1.beat1', '--letter', 'A');
    expect(result.code).toBe(EXIT.address);
  });
});
