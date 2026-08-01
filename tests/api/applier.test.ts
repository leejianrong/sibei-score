import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_OWNER, OperationError, createApplier, replay } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Applier, Operation, ScoreStore } from '@sibei/api';
import { dur, notesOf } from '@sibei/model';

/**
 * The applier against a real store (ADR-0003). Three properties get asserted here that cannot be
 * asserted anywhere else, because they are about persistence:
 *
 *   1. Replaying a score's op log from empty reproduces the stored document exactly.
 *   2. A stale expected version is rejected with the current version, and the score is unchanged.
 *   3. A batch containing one invalid operation applies none of its operations.
 */

const stores: ScoreStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

function fresh(): { store: ScoreStore; applier: Applier } {
  const store = openSqliteStore({ filename: ':memory:' });
  stores.push(store);
  return { store, applier: createApplier(store) };
}

const CREATE: Operation = {
  type: 'score.create',
  payload: { id: 'score-1', barCount: 4, title: 'Body and Soul' },
};

const note = (target: string, pitch: string): Operation => ({
  type: 'note.add',
  target,
  payload: { pitch, duration: dur(4) },
});

function authorAChart(): { store: ScoreStore; applier: Applier } {
  const { store, applier } = fresh();
  applier.apply(LOCAL_OWNER, null, { operations: [CREATE] });
  applier.apply(LOCAL_OWNER, 'score-1', { operations: [note('bar1.beat1', 'Eb5')] });
  applier.apply(LOCAL_OWNER, 'score-1', { operations: [note('bar1.beat2', 'F5')] });
  applier.apply(LOCAL_OWNER, 'score-1', { operations: [note('bar1.beat3', 'G5')] });
  return { store, applier };
}

describe('applying', () => {
  it('creates a score and returns its version and what changed', () => {
    const { store, applier } = fresh();
    const result = applier.apply(LOCAL_OWNER, null, { operations: [CREATE] });

    expect(result).toEqual({
      scoreId: 'score-1',
      version: 1,
      changed: ['score-1'],
      applied: [
        {
          type: 'score.create',
          payload: {
            id: 'score-1',
            barCount: 4,
            title: 'Body and Soul',
            bars: [
              { id: 'bar-1', number: 1 },
              { id: 'bar-2', number: 2 },
              { id: 'bar-3', number: 3 },
              { id: 'bar-4', number: 4 },
            ],
          },
        },
      ],
    });
    expect(store.get(LOCAL_OWNER, 'score-1')?.score.meta.title).toBe('Body and Soul');
  });

  it('bumps the version once per apply, whatever the batch length', () => {
    const { store, applier } = fresh();
    applier.apply(LOCAL_OWNER, null, { operations: [CREATE] });
    const result = applier.apply(LOCAL_OWNER, 'score-1', {
      operations: [note('bar1.beat1', 'Eb5'), note('bar1.beat2', 'F5'), note('bar1.beat3', 'G5')],
    });
    expect(result.version).toBe(2);
    expect(store.get(LOCAL_OWNER, 'score-1')?.version).toBe(2);
  });

  it('reports every id a batch touched', () => {
    const { applier } = fresh();
    applier.apply(LOCAL_OWNER, null, { operations: [CREATE] });
    const result = applier.apply(LOCAL_OWNER, 'score-1', {
      operations: [note('bar1.beat1', 'Eb5'), note('bar1.beat2', 'F5')],
    });
    expect(result.changed).toEqual(['note-1', 'note-2']);
  });

  it('refuses an empty batch', () => {
    const { applier } = fresh();
    expect(() => applier.apply(LOCAL_OWNER, null, { operations: [] })).toThrow(
      /at least one operation/,
    );
  });

  it('refuses a mutation of a score that is not there', () => {
    const { applier } = fresh();
    expect(() =>
      applier.apply(LOCAL_OWNER, 'score-404', { operations: [note('bar1.beat1', 'Eb5')] }),
    ).toThrow('there is no score with the id "score-404"');
  });

  it('refuses a second create of the same id', () => {
    const { applier } = fresh();
    applier.apply(LOCAL_OWNER, null, { operations: [CREATE] });
    expect(() => applier.apply(LOCAL_OWNER, null, { operations: [CREATE] })).toThrow(
      /already exists/,
    );
  });
});

describe('the op log', () => {
  it('records every operation in sequence, gaplessly', () => {
    const { store } = authorAChart();
    const log = store.operations(LOCAL_OWNER, 'score-1');
    expect(log.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(log.map((entry) => entry.operation.type)).toEqual([
      'score.create',
      'note.add',
      'note.add',
      'note.add',
    ]);
  });

  it('records the normalised operation, not the one that came in', () => {
    // The submitted op carried no id. The logged one does, which is what replay leans on.
    const { store } = authorAChart();
    const second = store.operations(LOCAL_OWNER, 'score-1')[1]!;
    expect(second.operation).toEqual({
      type: 'note.add',
      target: 'bar1.beat1',
      payload: { pitch: 'Eb5', duration: { value: 4, dots: 0 }, id: 'note-1' },
    });
  });

  it('groups a batch into one undoable unit, and a lone operation into a unit of one', () => {
    const { store, applier } = fresh();
    applier.apply(LOCAL_OWNER, null, { operations: [CREATE] });
    applier.apply(LOCAL_OWNER, 'score-1', {
      operations: [note('bar1.beat1', 'Eb5'), note('bar1.beat2', 'F5')],
    });
    applier.apply(LOCAL_OWNER, 'score-1', { operations: [note('bar1.beat3', 'G5')] });

    // Three applies, four operations, three batches — the second batch holding two of them.
    expect(store.operations(LOCAL_OWNER, 'score-1').map((entry) => entry.batch)).toEqual([
      1, 2, 2, 3,
    ]);
  });

  it('stamps each operation with the operation shape version, not the document’s', () => {
    const { store } = authorAChart();
    expect(store.operations(LOCAL_OWNER, 'score-1').every((entry) => entry.version === 1)).toBe(true);
  });

  it('is scoped by owner like everything else', () => {
    const { store } = authorAChart();
    expect(store.operations('someone-else', 'score-1')).toEqual([]);
  });

  it('goes when the score goes, which is why deleting cannot be an operation', () => {
    const { store } = authorAChart();
    expect(store.operations(LOCAL_OWNER, 'score-1')).not.toHaveLength(0);
    store.delete(LOCAL_OWNER, 'score-1');
    expect(store.operations(LOCAL_OWNER, 'score-1')).toEqual([]);
  });
});

describe('replaying the log from empty reproduces the document exactly', () => {
  it('holds for a chart authored one operation at a time', () => {
    // The property PLAN.md names by name, against a real log out of a real store.
    const { store } = authorAChart();
    const stored = store.get(LOCAL_OWNER, 'score-1')!.score;
    const log = store.operations(LOCAL_OWNER, 'score-1').map((entry) => entry.operation);

    expect(replay(log)).toEqual(stored);
  });

  it('holds after edits and removals, not just additions', () => {
    const { store, applier } = authorAChart();
    applier.apply(LOCAL_OWNER, 'score-1', {
      operations: [
        { type: 'note.set', target: 'bar1.n2', payload: { pitch: 'Gb5', duration: dur(8) } },
        { type: 'note.rm', target: 'bar1.n1' },
        { type: 'rest.add', target: 'bar1.beat1', payload: { duration: dur(4) } },
        { type: 'meta.set', payload: { composer: 'Johnny Green', style: 'Ballad' } },
      ],
    });

    const stored = store.get(LOCAL_OWNER, 'score-1')!.score;
    const log = store.operations(LOCAL_OWNER, 'score-1').map((entry) => entry.operation);
    expect(replay(log)).toEqual(stored);
  });

  it('holds through a rejected write, because a rejected write logs nothing', () => {
    const { store, applier } = authorAChart();
    expect(() =>
      applier.apply(LOCAL_OWNER, 'score-1', { operations: [note('bar1.beat1', 'C5')] }),
    ).toThrow(/already has a note/);

    const stored = store.get(LOCAL_OWNER, 'score-1')!.score;
    const log = store.operations(LOCAL_OWNER, 'score-1').map((entry) => entry.operation);
    expect(log).toHaveLength(4);
    expect(replay(log)).toEqual(stored);
  });
});

describe('the expected-version check (ADR-0003)', () => {
  it('accepts a write that names the current version', () => {
    const { applier } = authorAChart();
    const result = applier.apply(LOCAL_OWNER, 'score-1', {
      operations: [note('bar1.beat4', 'Ab5')],
      expectedVersion: 4,
    });
    expect(result.version).toBe(5);
  });

  it('rejects a stale write, names the current version, and changes nothing', () => {
    const { store, applier } = authorAChart();
    const before = store.get(LOCAL_OWNER, 'score-1')!;

    try {
      applier.apply(LOCAL_OWNER, 'score-1', {
        operations: [note('bar1.beat4', 'Ab5')],
        expectedVersion: 2,
      });
      expect.unreachable('a stale write must not be applied');
    } catch (error) {
      expect((error as OperationError).failure).toEqual({
        kind: 'stale-version',
        expected: 2,
        current: 4,
      });
      // No last-write-wins: the client is told what to retry at rather than silently winning.
      expect((error as OperationError).message).toMatch(/Re-read it and retry/);
    }

    const after = store.get(LOCAL_OWNER, 'score-1')!;
    expect(after.version).toBe(before.version);
    expect(after.score).toEqual(before.score);
    expect(store.operations(LOCAL_OWNER, 'score-1')).toHaveLength(4);
  });

  it('models the demo: the same edit twice, the second with a stale version', () => {
    const { store, applier } = authorAChart();
    const at = store.get(LOCAL_OWNER, 'score-1')!.version;

    const first = applier.apply(LOCAL_OWNER, 'score-1', {
      operations: [{ type: 'note.set', target: 'bar1.n1', payload: { pitch: 'Db5' } }],
      expectedVersion: at,
    });
    expect(first.version).toBe(at + 1);

    // A second client that read at the same time and is now behind by one.
    expect(() =>
      applier.apply(LOCAL_OWNER, 'score-1', {
        operations: [{ type: 'note.set', target: 'bar1.n1', payload: { pitch: 'C5' } }],
        expectedVersion: at,
      }),
    ).toThrow(/the score is at version 5, not 4/);

    // The first client's edit survived, which is the whole point.
    const notes = notesOf(store.get(LOCAL_OWNER, 'score-1')!.score.bars[0]!);
    expect(notes[0]?.pitch).toMatchObject({ step: 'D', alter: -1 });
  });

  it('treats an absent expected version as "whatever it is now"', () => {
    // The CLI's --if-version is optional; without it a write is a plain last-read-wins for one
    // client, which is right for a single-user tool driving itself.
    const { applier } = authorAChart();
    expect(applier.apply(LOCAL_OWNER, 'score-1', { operations: [note('bar1.beat4', 'Ab5')] }).version).toBe(5);
  });
});

describe('a batch is transactional (ADR-0008)', () => {
  it('applies none of its operations when one is invalid', () => {
    const { store, applier } = authorAChart();
    const before = store.get(LOCAL_OWNER, 'score-1')!;

    expect(() =>
      applier.apply(LOCAL_OWNER, 'score-1', {
        operations: [
          note('bar1.beat4', 'Ab5'), // fine
          note('bar2.beat1', 'Bb5'), // fine
          note('bar1.beat1', 'C5'), // occupied — the batch dies here
          note('bar2.beat2', 'C6'), // never reached
        ],
      }),
    ).toThrow(/already has a note/);

    const after = store.get(LOCAL_OWNER, 'score-1')!;
    expect(after.version).toBe(before.version);
    expect(after.score).toEqual(before.score);
    // And nothing reached the log either. Half a batch in the log would break replay forever.
    expect(store.operations(LOCAL_OWNER, 'score-1')).toHaveLength(4);
  });

  it('says which operation in the batch failed', () => {
    const { applier } = authorAChart();
    try {
      applier.apply(LOCAL_OWNER, 'score-1', {
        operations: [note('bar1.beat4', 'Ab5'), note('bar1.beat1', 'C5')],
      });
      expect.unreachable();
    } catch (error) {
      // 1-based in the message, 0-based in the structure. An agent needs to know which one.
      expect((error as OperationError).index).toBe(1);
      expect((error as OperationError).message).toMatch(/^operation 2: /);
    }
  });

  it('does not number the operation when the batch is a single one', () => {
    const { applier } = authorAChart();
    expect(() =>
      applier.apply(LOCAL_OWNER, 'score-1', { operations: [note('bar1.beat1', 'C5')] }),
    ).not.toThrow(/^operation 1:/);
  });

  it('applies all of them when all of them are valid, as one version bump', () => {
    const { store, applier } = authorAChart();
    const result = applier.apply(LOCAL_OWNER, 'score-1', {
      operations: [
        note('bar1.beat4', 'Ab5'),
        note('bar2.beat1', 'Bb5'),
        { type: 'meta.set', payload: { style: 'Medium swing' } },
      ],
    });
    expect(result.version).toBe(5);
    const score = store.get(LOCAL_OWNER, 'score-1')!.score;
    expect(score.bars[0]!.items).toHaveLength(4);
    expect(score.meta.style).toBe('Medium swing');
  });

  it('lets an operation later in the batch build on one earlier in it', () => {
    // Within a batch the fold is sequential, so adding a note and then editing it works.
    const { store, applier } = authorAChart();
    applier.apply(LOCAL_OWNER, 'score-1', {
      operations: [
        note('bar2.beat1', 'Bb5'),
        { type: 'note.set', target: 'bar2.beat1', payload: { duration: dur(2) } },
      ],
    });
    expect(notesOf(store.get(LOCAL_OWNER, 'score-1')!.score.bars[1]!)[0]!.duration).toEqual(dur(2));
  });

  it('rolls back a stale batch without logging any of it', () => {
    const { store, applier } = authorAChart();
    expect(() =>
      applier.apply(LOCAL_OWNER, 'score-1', {
        operations: [note('bar1.beat4', 'Ab5'), note('bar2.beat1', 'Bb5')],
        expectedVersion: 1,
      }),
    ).toThrow(/version 4, not 1/);
    expect(store.operations(LOCAL_OWNER, 'score-1')).toHaveLength(4);
  });
});

describe('a commit is one transaction', () => {
  it('rolls back the document when appending an operation fails partway through', () => {
    // The failure this guards against is the nastiest one available: a document written with only
    // half its operations logged. Replay would then reproduce a *different* score, silently and
    // forever, and no test that only checks the happy path would ever notice.
    //
    // Provoked without a fault-injection seam: the second operation carries a field the applier
    // tolerates (it copies only the fields it knows) but JSON cannot serialise, so the first
    // append succeeds and the second throws mid-transaction.
    const { store, applier } = authorAChart();
    const before = store.get(LOCAL_OWNER, 'score-1')!;

    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() =>
      applier.apply(LOCAL_OWNER, 'score-1', {
        operations: [
          { type: 'note.set', target: 'bar1.n1', payload: { duration: dur(2) } },
          {
            type: 'note.set',
            target: 'bar1.n2',
            payload: { duration: dur(2), junk: circular } as never,
          },
        ],
      }),
    ).toThrow();

    const after = store.get(LOCAL_OWNER, 'score-1')!;
    expect(after.version).toBe(before.version);
    expect(after.score).toEqual(before.score);
    expect(store.operations(LOCAL_OWNER, 'score-1')).toHaveLength(4);
  });
});

describe('the store refuses a write with no operation behind it', () => {
  it('because a document write without a logged operation is what ADR-0003 forbids', () => {
    // Structural, not a convention: the writer's signature requires the operations, and the store
    // refuses an empty list rather than trusting every future caller to remember.
    const { store } = fresh();
    const score = { schemaVersion: 1, id: 's', meta: {}, bars: [], sections: [] } as never;
    expect(() => store.create(LOCAL_OWNER, score, [])).toThrow(/must carry the operations/);
    expect(() => store.commit(LOCAL_OWNER, 's', 1, score, [])).toThrow(/must carry the operations/);
  });
});
