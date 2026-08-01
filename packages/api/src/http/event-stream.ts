import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Id } from '@sibei/model';
import type { ChangeEvent, ChangeSubscriber } from '../events/change-bus.js';
import type { Owner } from '../store/repository.js';

/**
 * Server-sent events: the wire the change bus goes out on.
 *
 * SSE rather than a WebSocket, and that is not a coin toss. The traffic is one-directional — writes
 * already have a path, and it is `POST …/ops`, which is the only write path there is (ADR-0003). A
 * socket that could carry an edit would be a second one, and "the UI and the CLI cannot disagree"
 * is a property of there being exactly one. SSE is also plain HTTP, so ADR-0029's guards cover it by
 * running before routing rather than by being reimplemented for a second protocol, and `EventSource`
 * reconnects on its own.
 *
 * ### There is no replay, deliberately
 *
 * No `id:` field is emitted, on any frame. That is a decision and not an omission: emitting one
 * makes a browser send `Last-Event-ID` on reconnect, and a server that ignores it has handed the
 * client a promise it does not keep. Replay would need a read surface over the op log, and KAN-510
 * has deliberately **not decided that shape** — inventing one here would freeze it by guesswork on
 * an API that goes additive-only after the hosted transition (ADR-0022).
 *
 * It is not needed, either, because of what the payload is. An event says only *what version exists
 * now*, so recovery is "re-read if that is not the version I hold" — and that is the same action
 * whether the client missed one event or a hundred. To make it structural rather than documented,
 * **the stream's first frame is a `changed` event carrying the score's current version**: opening
 * the connection *is* the catch-up, so a reconnecting client cannot forget to re-read.
 *
 * ### The `Origin` guard, and why a GET sails past it
 *
 * `checkOrigin` fires on state-changing methods only (ADR-0029), and an `EventSource` GET is not
 * one. So a hostile page **can** open this connection: its `Host` is `127.0.0.1`, which is exactly
 * what `checkHost` wants to see. It **cannot read a byte of it**, because this response carries no
 * CORS headers at all and the browser therefore refuses to hand the stream to the page.
 *
 * That is a guard working by *omission*, which is the kind of thing somebody later fixes into a
 * hole — the whole mechanism is one header nobody added. `tests/api/events.test.ts` pins it and
 * `tests/arch/http-boundary.test.ts` greps the tree for the header. Do not add one here.
 *
 * (What a hostile page can still do is hold a connection open. It learns nothing by it and there is
 * no cap on concurrent streams; tightening `checkOrigin` to cover this path would close it and
 * would cost nothing, since no legitimate cross-origin client exists. That is a change to ADR-0029's
 * shape rather than to this file, so it is noted here and not made here.)
 */

/** Long enough not to be chatter, short enough that a dead connection is noticed within a screenful. */
export const DEFAULT_HEARTBEAT_MS = 15_000;

export interface EventStreams {
  /**
   * Take over the response and stream to it. Returns the status **as soon as the headers are
   * written**, while the connection lives on.
   *
   * That is what makes a long-lived request log once, at open (ADR-0029's logging is narrow but it
   * still has to happen). `server.ts` writes its log line when this promise-shaped handler returns,
   * so resolving at close instead would mean an open stream appears in no log at all for as long as
   * it matters, and then arrives with a `durationMs` measuring the connection rather than the
   * server's work — a different quantity from every other line's.
   */
  open(
    request: IncomingMessage,
    response: ServerResponse,
    owner: Owner,
    scoreId: Id,
    version: number,
  ): number;
  /**
   * End every open stream.
   *
   * `Api.close()` needs this. `server.close()` stops accepting connections and then **waits for the
   * open ones to finish**, and an SSE stream by definition never finishes — so before this existed,
   * closing a server with a stream open hung forever. Found in the first test written against this
   * endpoint. The fix closes exactly what this module opened rather than reaching for
   * `closeAllConnections()`, which would also cut off an unrelated in-flight request.
   */
  closeAll(): void;
  /** How many streams are open. The only way to assert that a disconnect does not leak one. */
  readonly openCount: number;
}

export interface EventStreamOptions {
  subscriber: ChangeSubscriber;
  /** Overridden only by tests, which cannot wait 15 seconds to see a heartbeat. */
  heartbeatMs?: number;
}

export function createEventStreams(options: EventStreamOptions): EventStreams {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  /** Every live stream's own teardown. The registry `closeAll` and the leak assertion both read. */
  const live = new Set<() => void>();

  return {
    open(request, response, owner, scoreId, version) {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        // A stream is never a cached artefact. The export path is where caching lives (Q81).
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-content-type-options': 'nosniff',
        // No CORS header. See the note at the top of this file before adding one.
      });

      let closed = false;

      const write = (frame: string): void => {
        if (closed || response.writableEnded || response.destroyed) return;
        response.write(frame);
      };

      const listener = (event: ChangeEvent): void => write(frameFor(event));

      const unsubscribe = options.subscriber.subscribe(owner, scoreId, listener);

      // A comment line, which SSE defines as data-free, so it costs a client nothing to receive and
      // proves the connection is still there. Without it a stream that died in a way neither end
      // noticed — the usual sleep/resume — looks exactly like a score nobody is editing.
      const heartbeat = setInterval(() => write(': heartbeat\n\n'), heartbeatMs);
      // A timer must never be the reason a process will not exit. `closeAll` clears it in the
      // ordinary case; this covers the one where nothing does.
      heartbeat.unref();

      const close = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        live.delete(close);
        response.end();
      };

      live.add(close);
      // Both halves: `close` on the request covers the client going away, and an error on the
      // response covers the socket dying under us. Either way the subscription goes with it —
      // a listener writing to a dead response is what a connection leak looks like from in here.
      request.on('close', close);
      response.on('error', close);

      // The catch-up frame. See the header comment: opening the connection is the re-read trigger,
      // which is what makes "reconnect and re-read" work without the client having to remember it.
      write(frameFor({ kind: 'changed', scoreId, version }));

      return 200;
    },

    closeAll() {
      for (const close of [...live]) close();
    },

    get openCount() {
      return live.size;
    },
  };
}

/**
 * One SSE frame.
 *
 * The event's `kind` is the `event:` field and is **not repeated in the data** — SSE already has a
 * place for the type of a thing, and two places for it would be two things to keep in step.
 *
 * `data:` is one line because `JSON.stringify` escapes every newline it could contain, which matters
 * more than it looks: a score id is client-supplied (`score.create` takes one), so a raw newline in
 * one would otherwise end the frame early and let a caller inject frames of their own.
 */
function frameFor(event: ChangeEvent): string {
  const data =
    event.kind === 'changed'
      ? { scoreId: event.scoreId, version: event.version }
      : { scoreId: event.scoreId };
  // No `id:` field, on purpose. See the header comment.
  return `event: ${event.kind}\ndata: ${JSON.stringify(data)}\n\n`;
}
