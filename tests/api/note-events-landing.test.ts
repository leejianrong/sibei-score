import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_OWNER, createApplier, replayLog } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { ScoreStore } from '@sibei/api';
import { mapNoteEventsToScore, parseNoteEvents } from '@sibei/model';

/** A NoteEvents draft lands through the server-only `Applier.import` as one `score.import` (ADR-0040 #7). */
const stores: ScoreStore[] = [];
afterEach(async () => {
  while (stores.length > 0) await stores.pop()?.close();
});

describe('NoteEvents draft landing', () => {
  it('is a normal score with a fresh one-op history that replays exactly', async () => {
    const store = openSqliteStore({ filename: ':memory:' });
    stores.push(store);
    const applier = createApplier(store);
    const raw = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'note-events', 'voice-ode-beats.json'), 'utf8'));
    const { score } = mapNoteEventsToScore(parseNoteEvents(raw), { id: 'import-1' });

    expect(await applier.import(LOCAL_OWNER, score)).toEqual({ scoreId: 'import-1', version: 1 });
    const log = await store.operations(LOCAL_OWNER, 'import-1');
    expect(log.map((l) => l.operation.type)).toEqual(['score.import']);
    expect(replayLog(log)).toEqual((await store.get(LOCAL_OWNER, 'import-1'))!.score);
  });
});
