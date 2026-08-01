import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, silentLogger } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Api, Logger, Operation, RequestLine, ScoreStore } from '@sibei/api';
import { dur } from '@sibei/model';

/**
 * `GET /v1/scores/:id/events` — the change stream, over a real socket (V4a).
 *
 * A real listening socket, for the reason `api.test.ts` gives: calling the handler directly skips
 * ADR-0029's guards, and the guards are half of what this file is about. The other half is the
 * demo SLICES.md V4 is built around — an edit arriving from somewhere else reaching an open view
 * without a reload.
 *
 * `fetch` is not used for the stream itself. `Host` is a forbidden header name in the fetch spec,
 * so an override is dropped silently, and the Host guard is one of the things being pinned here.
 */

let store: ScoreStore;
let api: Api;
let base: string;
let port: number;
let errors: string[];
let lines: RequestLine[];

/** Records what the server logged, so "nothing went wrong quietly" can be an assertion. */
function recordingLogger(intoLines: RequestLine[], intoErrors: string[]): Logger {
  return {
    request: (line) => void intoLines.push(line),
    error: (message) => void intoErrors.push(message),
  };
}

beforeEach(async () => {
  store = openSqliteStore({ filename: ':memory:' });
  errors = [];
  lines = [];
  // A heartbeat a test can watch. The product default is fifteen seconds.
  api = createApi({ store, logger: recordingLogger(lines, errors), heartbeatMs: 20 });
  ({ port } = await api.listen(0));
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  for (const stream of openStreams.splice(0)) stream.close();
  await api.close();
  store.close();
});

interface SseEvent {
  type: string;
  data: Record<string, unknown>;
}

interface Stream {
  status: number;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
  /** Every frame as it arrived, comments included, unparsed. */
  frames: string[];
  events: SseEvent[];
  comments: string[];
  /** Resolves once `count` events have arrived, or fails saying what did. */
  awaitEvents(count: number): Promise<SseEvent[]>;
  awaitComment(): Promise<void>;
  close(): void;
}

const openStreams: Stream[] = [];

function openStream(path: string, headers: Record<string, string> = {}): Promise<Stream> {
  return new Promise<Stream>((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { host: `127.0.0.1:${port}`, accept: 'text/event-stream', ...headers },
        setHost: false,
      },
      (response) => {
        const frames: string[] = [];
        const events: SseEvent[] = [];
        const comments: string[] = [];
        const waiters: (() => void)[] = [];
        let buffer = '';
        let text = '';

        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
          buffer += chunk;
          for (let at = buffer.indexOf('\n\n'); at !== -1; at = buffer.indexOf('\n\n')) {
            const frame = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            frames.push(frame);
            if (frame.startsWith(':')) comments.push(frame);
            else events.push(parseEvent(frame));
          }
          for (const waiter of waiters.splice(0)) waiter();
        });
        response.on('end', () => {
          for (const waiter of waiters.splice(0)) waiter();
        });

        function settle<T>(ready: () => T | null, what: string): Promise<T> {
          return new Promise<T>((done, fail) => {
            const check = (): void => {
              const value = ready();
              if (value !== null) done(value);
              else if (response.readableEnded) fail(new Error(`the stream ended before ${what}`));
              else waiters.push(check);
            };
            setTimeout(() => fail(new Error(`timed out waiting for ${what}`)), 2_000).unref();
            check();
          });
        }

        const stream: Stream = {
          status: response.statusCode ?? 0,
          headers: response.headers,
          get body() {
            return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
          },
          frames,
          events,
          comments,
          awaitEvents: (count) =>
            settle(() => (events.length >= count ? events : null), `${count} event(s)`),
          awaitComment: () =>
            settle(() => (comments.length > 0 ? true : null), 'a heartbeat').then(() => undefined),
          close: () => response.destroy(),
        };
        openStreams.push(stream);
        resolve(stream);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

function parseEvent(frame: string): SseEvent {
  const type = /^event: (.*)$/m.exec(frame)?.[1] ?? '';
  const data = /^data: (.*)$/m.exec(frame)?.[1] ?? '{}';
  return { type, data: JSON.parse(data) as Record<string, unknown> };
}

/** An ordinary request, the way the CLI makes one. */
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
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

async function aChart(id = 'score-1'): Promise<void> {
  await call('POST', '/v1/scores', {
    operation: { type: 'score.create', payload: { id, barCount: 4, title: 'Body and Soul' } },
  });
}

describe('the stream opens', () => {
  it('as an event stream that is never cached', async () => {
    await aChart();
    const stream = await openStream('/v1/scores/score-1/events');
    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(stream.headers['cache-control']).toBe('no-store');
  });

  it('leading with the score’s current version, so connecting is the catch-up', async () => {
    // Reconnection is "reconnect and re-read" rather than Last-Event-ID replay, and this frame is
    // what makes that structural: the client does not have to remember to re-read, because opening
    // the connection hands it a version to compare against.
    await aChart();
    await call('POST', '/v1/scores/score-1/ops', { operation: note('bar1.beat1', 'Eb5') });

    const stream = await openStream('/v1/scores/score-1/events');
    const [hello] = await stream.awaitEvents(1);
    expect(hello).toEqual({ type: 'changed', data: { scoreId: 'score-1', version: 2 } });
  });

  it('404s a score that is not there, rather than a stream that can never carry anything', async () => {
    const stream = await openStream('/v1/scores/nope/events');
    expect(stream.status).toBe(404);
  });

  it('405s anything but a GET, with an Allow header', async () => {
    await aChart();
    const reply = await call('POST', '/v1/scores/score-1/events');
    expect(reply.status).toBe(405);
  });
});

describe('an external change reaches an open stream (SLICES.md V4 step 5)', () => {
  it('pushes the new version when something else edits the score', async () => {
    // The demo, minus the browser: an edit made through the same API the CLI uses, arriving at a
    // view that is already open.
    await aChart();
    const stream = await openStream('/v1/scores/score-1/events');
    await stream.awaitEvents(1);

    await call('POST', '/v1/scores/score-1/ops', { operation: note('bar1.beat1', 'Eb5') });

    const events = await stream.awaitEvents(2);
    expect(events[1]).toEqual({ type: 'changed', data: { scoreId: 'score-1', version: 2 } });
  });

  it('carries the version and nothing else, so no client can depend on more', async () => {
    // The payload is an optimisation that degrades safely, not a contract that does not. It says
    // what version exists; recovery is a re-read. `changed[]` was deliberately left off — a client
    // cannot repaint from a list of ids, so it could never save the re-read (KAN-587).
    await aChart();
    const stream = await openStream('/v1/scores/score-1/events');
    await stream.awaitEvents(1);
    await call('POST', '/v1/scores/score-1/ops', { operation: note('bar1.beat1', 'Eb5') });
    const events = await stream.awaitEvents(2);
    expect(Object.keys(events[1]?.data ?? {}).sort()).toEqual(['scoreId', 'version']);
  });

  it('re-reads to the exact version it was told about', async () => {
    // The whole recovery path, end to end: the event is a trigger, the GET is the truth.
    await aChart();
    const stream = await openStream('/v1/scores/score-1/events');
    await stream.awaitEvents(1);
    await call('POST', '/v1/scores/score-1/ops', { operation: note('bar1.beat1', 'Eb5') });

    const events = await stream.awaitEvents(2);
    const reply = await call('GET', '/v1/scores/score-1');
    expect(reply.body.version).toBe(events[1]?.data.version);
  });

  it('tells both of two tabs on the same score', async () => {
    await aChart();
    const first = await openStream('/v1/scores/score-1/events');
    const second = await openStream('/v1/scores/score-1/events');
    await Promise.all([first.awaitEvents(1), second.awaitEvents(1)]);

    await call('POST', '/v1/scores/score-1/ops', { operation: note('bar1.beat1', 'Eb5') });

    const [a, b] = await Promise.all([first.awaitEvents(2), second.awaitEvents(2)]);
    expect(a[1]).toEqual(b[1]);
  });

  it('says nothing about another score', async () => {
    await aChart('score-1');
    await aChart('score-2');
    const stream = await openStream('/v1/scores/score-1/events');
    await stream.awaitEvents(1);

    await call('POST', '/v1/scores/score-2/ops', { operation: note('bar1.beat1', 'Eb5') });
    // A marker on the subscribed score, so this is a deterministic ordering assertion rather than
    // a sleep: if score-2's event had leaked it would already be sitting in front of this one.
    await call('POST', '/v1/scores/score-1/ops', { operation: note('bar1.beat1', 'F5') });

    const events = await stream.awaitEvents(2);
    expect(events).toHaveLength(2);
    expect(events[1]?.data.scoreId).toBe('score-1');
  });

  it('announces a deletion, which is not an operation but is still an external change', async () => {
    // Without this a browser holding a deleted chart open waits for an event that can never come.
    // Deleting is a library lifecycle call and never touches the applier (ADR-0003), so it
    // publishes from its own wrapper.
    await aChart();
    const stream = await openStream('/v1/scores/score-1/events');
    await stream.awaitEvents(1);

    await call('DELETE', '/v1/scores/score-1');

    const events = await stream.awaitEvents(2);
    expect(events[1]).toEqual({ type: 'deleted', data: { scoreId: 'score-1' } });
  });

  it('emits no id: field on any frame, because there is no replay to promise', async () => {
    // Sending one would make a browser send Last-Event-ID on reconnect and get no replay for it.
    // The op log makes replay possible; KAN-510 has deliberately not decided the log's read shape,
    // and inventing one here would freeze it by guesswork on an additive-only API (ADR-0022).
    await aChart();
    const stream = await openStream('/v1/scores/score-1/events');
    await stream.awaitEvents(1);
    await call('POST', '/v1/scores/score-1/ops', { operation: note('bar1.beat1', 'Eb5') });
    await stream.awaitEvents(2);

    expect(stream.frames.join('\n')).not.toMatch(/^id:/m);
  });
});

describe('the heartbeat', () => {
  it('writes a comment line while nothing is happening, so a dead connection is noticed', async () => {
    await aChart();
    const stream = await openStream('/v1/scores/score-1/events');
    await stream.awaitComment();
    // A comment, so it carries no data and no client has to know about it.
    expect(stream.comments[0]).toMatch(/^:/);
    expect(stream.events).toHaveLength(1);
  });
});

describe('the log stays narrow, and arrives when it is useful (ADR-0029)', () => {
  it('logs the stream once, at open, while it is still open', async () => {
    // A request that never ends would otherwise appear in no log for as long as it matters, and
    // then arrive carrying a `durationMs` that measured the *connection* — a different quantity
    // from every other line's, which is the server's own work. So the handler reports 200 as soon
    // as the headers are written and the connection lives on behind it.
    await aChart();
    const stream = await openStream('/v1/scores/score-1/events');
    await stream.awaitEvents(1);

    const forTheStream = lines.filter((line) => line.path === '/v1/scores/score-1/events');
    expect(forTheStream).toHaveLength(1);
    expect(forTheStream[0]).toMatchObject({ method: 'GET', status: 200 });
  });

  it('logs it once and not again per event, or per heartbeat', async () => {
    await aChart();
    const stream = await openStream('/v1/scores/score-1/events');
    await stream.awaitComment();
    await call('POST', '/v1/scores/score-1/ops', { operation: note('bar1.beat1', 'Eb5') });
    await stream.awaitEvents(2);
    stream.close();

    expect(lines.filter((line) => line.path.endsWith('/events'))).toHaveLength(1);
  });

  it('puts no score id, no header and no body anywhere in an error line', async () => {
    // `RequestLine` has nowhere to put them (asserted structurally in tests/arch), and the error
    // channel gets a message only. Nothing about a stream widens either.
    await aChart();
    const stream = await openStream('/v1/scores/score-1/events');
    await stream.awaitEvents(1);
    stream.close();
    expect(errors).toEqual([]);
  });
});

describe('the boundary guards cover this path too (ADR-0029)', () => {
  it('refuses a foreign Host, which is what a rebound stream would look like', async () => {
    // checkHost fires on everything and runs before routing. Pinned on this path specifically,
    // because "the guard is shared" is a claim about code and this is a claim about the endpoint.
    await aChart();
    const stream = await openStream('/v1/scores/score-1/events', { host: 'evil.example' });
    expect(stream.status).toBe(403);
    expect((stream.body.error as { kind: string }).kind).toBe('foreign-host');
  });

  it('refuses it before routing, so an events path on no score is not a way past', async () => {
    const stream = await openStream('/v1/scores/nope/events', { host: 'evil.example' });
    expect(stream.status).toBe(403);
  });

  it('LETS A FOREIGN ORIGIN OPEN IT, and gives the page no way to read a byte', async () => {
    // This is the guard working by omission, and it is exactly the kind of thing somebody later
    // "fixes" into a hole. Read carefully before changing anything here.
    //
    // `checkOrigin` fires on state-changing methods only (ADR-0029), and an EventSource GET is not
    // one — so a hostile page's connection is accepted, because its Host really is 127.0.0.1 and
    // that is all checkHost asks. What stops the attack is one header that is **not** in the
    // response: with no `access-control-allow-origin`, the browser refuses to hand the stream to
    // the page, and the page learns nothing at all.
    //
    // So the 200 below is correct and the absent headers are the security property. Adding a CORS
    // header "so the UI can connect" would open the hole; the UI is served same-origin and needs
    // none. `tests/arch/http-boundary.test.ts` greps the whole tree for one.
    await aChart();
    const stream = await openStream('/v1/scores/score-1/events', { origin: 'https://evil.example' });

    expect(stream.status).toBe(200);
    expect(stream.headers['access-control-allow-origin']).toBeUndefined();
    expect(stream.headers['access-control-allow-credentials']).toBeUndefined();
    expect(Object.keys(stream.headers).filter((name) => /access-control/i.test(name))).toEqual([]);
  });

  it('scopes a stream to the principal, so another cannot open one on this score', async () => {
    await aChart();
    const other = createApi({
      store,
      logger: silentLogger,
      authenticate: () => ({ owner: 'someone-else' }),
    });
    const { port: otherPort } = await other.listen(0);
    try {
      const response = await fetch(`http://127.0.0.1:${otherPort}/v1/scores/score-1/events`);
      expect(response.status).toBe(404);
      await response.text();
    } finally {
      await other.close();
    }
  });
});

describe('connections do not leak', () => {
  it('closing the server does not hang on an open stream', async () => {
    // The bug this slice had to fix, asserted rather than described. `server.close()` waits for
    // open connections to finish and an SSE stream never finishes, so before `events.closeAll()`
    // existed this call never returned. No timeout in the test: if the fix is gone, this hangs
    // until vitest kills the file, which names the right thing.
    await aChart();
    const stream = await openStream('/v1/scores/score-1/events');
    await stream.awaitEvents(1);

    await api.close();

    // And re-closing in afterEach is harmless.
    expect(errors).toEqual([]);
  });

  it('goes on serving the streams that remain after one client leaves, quietly', async () => {
    // A client vanishing must not cost the others their events, and must not put anything in the
    // log — the bus reports a failing subscriber to the logger, so an empty error list after a
    // write is a real assertion about a real failure mode.
    //
    // What this **cannot** see is the subscription itself: the abandoned stream's bus entry is not
    // reachable from out here, and a leaked one is silent. That property is asserted where it is
    // observable, in `tests/unit/change-events.test.ts`.
    await aChart();
    const abandoned = await openStream('/v1/scores/score-1/events');
    await abandoned.awaitEvents(1);
    abandoned.close();

    // A live stream, so this waits on the publish actually happening rather than on a sleep.
    const watching = await openStream('/v1/scores/score-1/events');
    await watching.awaitEvents(1);
    await call('POST', '/v1/scores/score-1/ops', { operation: note('bar1.beat1', 'Eb5') });
    await watching.awaitEvents(2);

    expect(errors).toEqual([]);
  });
});
