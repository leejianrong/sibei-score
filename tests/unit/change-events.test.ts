import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  createChangeBus,
  createEventStreams,
  publishingApplier,
  publishingLibrary,
} from '@sibei/api';
import type {
  Applier,
  ApplyResult,
  ChangeEvent,
  ChangeSubscriber,
  ScoreLibrary,
} from '@sibei/api';

/**
 * The change bus and the SSE framing, without a socket (V4a).
 *
 * `tests/api/events.test.ts` drives the endpoint over real HTTP, which is where the guards live and
 * where most of this slice's behaviour belongs. Two things are not observable from out there and
 * are the reason this file exists: **owner scoping inside the bus**, which the route's own 404
 * masks over the wire, and **the count of open streams**, which is the only direct way to say that
 * a client going away does not leak a subscription.
 */

const ANY_BATCH = { operations: [] };

function resultOf(scoreId: string, version: number): ApplyResult {
  return { scoreId, version, changed: [], applied: [] };
}

describe('the change bus', () => {
  it('tells a subscriber about the score it subscribed to', () => {
    const bus = createChangeBus();
    const heard: ChangeEvent[] = [];
    bus.subscribe('local', 'score-1', (event) => heard.push(event));

    bus.publish('local', { kind: 'changed', scoreId: 'score-1', version: 4 });

    expect(heard).toEqual([{ kind: 'changed', scoreId: 'score-1', version: 4 }]);
  });

  it('tells every subscriber on that score, which is the two-tabs case', () => {
    const bus = createChangeBus();
    const first: ChangeEvent[] = [];
    const second: ChangeEvent[] = [];
    bus.subscribe('local', 'score-1', (event) => first.push(event));
    bus.subscribe('local', 'score-1', (event) => second.push(event));

    bus.publish('local', { kind: 'changed', scoreId: 'score-1', version: 2 });

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('tells nobody about another score', () => {
    const bus = createChangeBus();
    const heard: ChangeEvent[] = [];
    bus.subscribe('local', 'score-1', (event) => heard.push(event));

    bus.publish('local', { kind: 'changed', scoreId: 'score-2', version: 9 });

    expect(heard).toEqual([]);
  });

  it('tells nobody about another owner’s score of the same id', () => {
    // Every store query filters on the owner anyway (R8), and a stream that did not would be the
    // one place a principal could learn something about another's library — that a chart by that
    // id exists, and every time somebody edits it. Not reachable over HTTP, because the route
    // 404s a score the principal cannot read; asserted here so the bus does not become the hole
    // if that ever changes.
    const bus = createChangeBus();
    const heard: ChangeEvent[] = [];
    bus.subscribe('someone-else', 'score-1', (event) => heard.push(event));

    bus.publish('local', { kind: 'changed', scoreId: 'score-1', version: 2 });

    expect(heard).toEqual([]);
  });

  it('stops telling a listener that unsubscribed', () => {
    const bus = createChangeBus();
    const heard: ChangeEvent[] = [];
    const unsubscribe = bus.subscribe('local', 'score-1', (event) => heard.push(event));

    unsubscribe();
    unsubscribe(); // Twice is harmless: a stream's teardown runs from more than one event.
    bus.publish('local', { kind: 'changed', scoreId: 'score-1', version: 2 });

    expect(heard).toEqual([]);
  });

  it('reports a listener’s failure and carries on to the next one', () => {
    // The publish happens after a write has already landed. A subscriber that throws must not be
    // able to turn a successful edit into a 500, and must not silently cost the other subscribers
    // their event either.
    const onError = vi.fn();
    const bus = createChangeBus({ onError });
    const heard: ChangeEvent[] = [];
    bus.subscribe('local', 'score-1', () => {
      throw new Error('a subscriber fell over');
    });
    bus.subscribe('local', 'score-1', (event) => heard.push(event));

    expect(() => bus.publish('local', { kind: 'changed', scoreId: 'score-1', version: 2 })).not.toThrow();
    expect(heard).toHaveLength(1);
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('the mutating paths announce what they did', () => {
  it('publishes the version the applier returned, after it returned it', () => {
    const bus = createChangeBus();
    const heard: ChangeEvent[] = [];
    bus.subscribe('local', 'score-1', (event) => heard.push(event));

    const applier: Applier = { apply: () => resultOf('score-1', 7) };
    const result = publishingApplier(applier, bus).apply('local', 'score-1', ANY_BATCH);

    expect(result.version).toBe(7);
    expect(heard).toEqual([{ kind: 'changed', scoreId: 'score-1', version: 7 }]);
  });

  it('publishes nothing when the apply threw, because nothing landed (ADR-0008)', () => {
    const bus = createChangeBus();
    const heard: ChangeEvent[] = [];
    bus.subscribe('local', 'score-1', (event) => heard.push(event));

    const applier: Applier = {
      apply: () => {
        throw new Error('refused');
      },
    };
    expect(() => publishingApplier(applier, bus).apply('local', 'score-1', ANY_BATCH)).toThrow();
    expect(heard).toEqual([]);
  });

  it('publishes a deletion, but only a real one', () => {
    const bus = createChangeBus();
    const heard: ChangeEvent[] = [];
    bus.subscribe('local', 'score-1', (event) => heard.push(event));

    const library: ScoreLibrary = { delete: (_owner, id) => id === 'score-1' };
    const publishing = publishingLibrary(library, bus);

    expect(publishing.delete('local', 'score-1')).toBe(true);
    // A 404 is not an event.
    expect(publishing.delete('local', 'score-1-that-is-not-there')).toBe(false);

    expect(heard).toEqual([{ kind: 'deleted', scoreId: 'score-1' }]);
  });
});

/** Just enough of a request and a response to drive the stream without a socket. */
function fakeConnection(): {
  request: IncomingMessage;
  response: ServerResponse;
  written: string[];
  status: number | null;
  headers: Record<string, unknown>;
  ended: () => boolean;
  disconnect: () => void;
} {
  const written: string[] = [];
  const listeners = new Map<string, (() => void)[]>();
  const state = { status: null as number | null, headers: {} as Record<string, unknown>, ended: false };

  const on = (event: string, listener: () => void): void => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
  };

  const request = { on } as unknown as IncomingMessage;
  const response = {
    writeHead(status: number, headers: Record<string, unknown>) {
      state.status = status;
      state.headers = headers;
      return response;
    },
    write(frame: string) {
      written.push(frame);
      return true;
    },
    end() {
      state.ended = true;
      return response;
    },
    on(event: string, listener: () => void) {
      on(event, listener);
      return response;
    },
    get writableEnded() {
      return state.ended;
    },
    destroyed: false,
  } as unknown as ServerResponse;

  return {
    request,
    response,
    written,
    get status() {
      return state.status;
    },
    get headers() {
      return state.headers;
    },
    ended: () => state.ended,
    disconnect: () => {
      for (const listener of listeners.get('close') ?? []) listener();
    },
  };
}

describe('the SSE stream', () => {
  it('opens with the event-stream content type and no CORS header of any kind', () => {
    // The guard by omission (ADR-0029): a hostile page can *open* this, because checkOrigin fires
    // on state-changing methods only — and it can read nothing, because of the header that is not
    // here. Pinned over the wire too, in tests/api/events.test.ts.
    const bus = createChangeBus();
    const streams = createEventStreams({ subscriber: bus });
    const connection = fakeConnection();

    streams.open(connection.request, connection.response, 'local', 'score-1', 1);

    expect(connection.status).toBe(200);
    expect(connection.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(Object.keys(connection.headers).some((name) => /access-control/i.test(name))).toBe(false);
  });

  it('leads with the score’s current version, so connecting is the catch-up', () => {
    const bus = createChangeBus();
    const streams = createEventStreams({ subscriber: bus });
    const connection = fakeConnection();

    streams.open(connection.request, connection.response, 'local', 'score-1', 5);

    expect(connection.written).toEqual(['event: changed\ndata: {"scoreId":"score-1","version":5}\n\n']);
  });

  it('emits no id: field, because there is no replay to promise (KAN-510)', () => {
    // Emitting one makes a browser send Last-Event-ID on reconnect, and a server that ignores it
    // has handed the client a promise it does not keep. Recovery is "re-read at the version you
    // were told", which needs no id.
    const bus = createChangeBus();
    const streams = createEventStreams({ subscriber: bus, heartbeatMs: 5 });
    const connection = fakeConnection();

    streams.open(connection.request, connection.response, 'local', 'score-1', 1);
    bus.publish('local', { kind: 'changed', scoreId: 'score-1', version: 2 });
    bus.publish('local', { kind: 'deleted', scoreId: 'score-1' });

    expect(connection.written.join('')).not.toMatch(/^id:/m);
  });

  it('names a deletion as its own event type rather than a version that is not there', () => {
    const bus = createChangeBus();
    const streams = createEventStreams({ subscriber: bus });
    const connection = fakeConnection();

    streams.open(connection.request, connection.response, 'local', 'score-1', 1);
    bus.publish('local', { kind: 'deleted', scoreId: 'score-1' });

    expect(connection.written.at(-1)).toBe('event: deleted\ndata: {"scoreId":"score-1"}\n\n');
  });

  it('cannot have a frame ended early by a score id, which is client-supplied', () => {
    // `score.create` takes the id from the caller. A raw newline in one would close the frame and
    // let the caller write frames of their own; JSON.stringify escapes it, and this says so.
    const bus = createChangeBus();
    const streams = createEventStreams({ subscriber: bus });
    const connection = fakeConnection();

    streams.open(connection.request, connection.response, 'local', 'nasty\n\nevent: deleted', 1);

    const frames = connection.written.join('').split('\n\n').filter((frame) => frame !== '');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatch(/^event: changed\ndata: \{"scoreId":"nasty\\n\\nevent: deleted"/);
  });

  it('beats a heart while nothing is happening', async () => {
    const bus = createChangeBus();
    const streams = createEventStreams({ subscriber: bus, heartbeatMs: 5 });
    const connection = fakeConnection();

    streams.open(connection.request, connection.response, 'local', 'score-1', 1);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(connection.written.filter((frame) => frame.startsWith(':')).length).toBeGreaterThan(0);
    streams.closeAll();
  });

  it('lets a disconnected client go, subscription and all', () => {
    // The leak, stated directly, and stated at the subscription rather than at the writes — the
    // first version of this test asserted "nothing more is written after a disconnect" and passed
    // with the `unsubscribe()` deleted, because the stream's own `closed` flag swallows the write.
    // That is the shape of leak worth expecting: it does not fail, it accumulates. A subscription
    // left in the bus stays there for the life of the process, one per connection ever opened, and
    // nothing anywhere goes red.
    const bus = createChangeBus();
    const watched = countingSubscriber(bus);
    const streams = createEventStreams({ subscriber: watched });
    const connection = fakeConnection();

    streams.open(connection.request, connection.response, 'local', 'score-1', 1);
    expect([streams.openCount, watched.subscribed]).toEqual([1, 1]);

    connection.disconnect();

    expect(streams.openCount).toBe(0);
    expect(watched.unsubscribed).toBe(1);
    expect(connection.ended()).toBe(true);
    // And, belt and braces, it writes nothing to the response it just ended.
    const before = connection.written.length;
    bus.publish('local', { kind: 'changed', scoreId: 'score-1', version: 2 });
    expect(connection.written).toHaveLength(before);
  });

  it('ends every open stream on closeAll, which is what stops Api.close hanging', () => {
    const bus = createChangeBus();
    const watched = countingSubscriber(bus);
    const streams = createEventStreams({ subscriber: watched });
    const first = fakeConnection();
    const second = fakeConnection();

    streams.open(first.request, first.response, 'local', 'score-1', 1);
    streams.open(second.request, second.response, 'local', 'score-2', 1);
    expect(streams.openCount).toBe(2);

    streams.closeAll();

    expect(streams.openCount).toBe(0);
    expect(watched.unsubscribed).toBe(2);
    expect([first.ended(), second.ended()]).toEqual([true, true]);
  });
});

/** A subscriber that counts what was subscribed and what was let go of. */
function countingSubscriber(
  bus: ChangeSubscriber,
): ChangeSubscriber & { subscribed: number; unsubscribed: number } {
  const counts = { subscribed: 0, unsubscribed: 0 };
  return {
    get subscribed() {
      return counts.subscribed;
    },
    get unsubscribed() {
      return counts.unsubscribed;
    },
    subscribe(owner, scoreId, listener) {
      counts.subscribed += 1;
      const unsubscribe = bus.subscribe(owner, scoreId, listener);
      return () => {
        counts.unsubscribed += 1;
        unsubscribe();
      };
    },
  };
}
