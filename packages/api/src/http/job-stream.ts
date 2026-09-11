import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JobChanged, JobSubscriber } from '../events/job-bus.js';
import type { JobId, JobStatus } from '../store/jobs.js';
import type { Owner } from '../store/repository.js';

/**
 * Server-sent events for import-job progress: the wire the job bus goes out on. The sibling of
 * `event-stream.ts`, and everything true there is true here — SSE not WebSocket (the traffic is
 * one-directional, and the only write path stays `POST …/ops`, ADR-0003); no `id:` field and so no
 * replay (the payload is a nudge to re-read, not a log to catch up on); the first frame carries the
 * job's *current* status so opening the connection is itself the catch-up; and no CORS header at
 * all, which is the omission that lets a hostile page open but never read this stream (ADR-0029).
 * Read that file's header before touching this one.
 *
 * The single difference is the payload: a job frame carries `{ jobId, status }`, the job bus's
 * event. A client repaints its progress from `status` and re-reads the job for detail — the
 * recognised objects on `succeeded`, the diagnostic on `failed`.
 */

/** Long enough not to be chatter, short enough that a dead connection is noticed within a screenful. */
export const DEFAULT_JOB_HEARTBEAT_MS = 15_000;

export interface JobStreams {
  /**
   * Take over the response and stream this job's progress to it. Returns the status as soon as the
   * headers are written, while the connection lives on — the same contract as the score stream, and
   * for the same logging reason.
   */
  open(
    request: IncomingMessage,
    response: ServerResponse,
    owner: Owner,
    jobId: JobId,
    status: JobStatus,
  ): number;
  /** End every open stream. `Api.close()` needs this, for the reason `event-stream.ts` explains. */
  closeAll(): void;
  /** How many streams are open. The only way to assert a disconnect does not leak one. */
  readonly openCount: number;
}

export interface JobStreamOptions {
  subscriber: JobSubscriber;
  /** Overridden only by tests, which cannot wait fifteen seconds to see a heartbeat. */
  heartbeatMs?: number;
}

export function createJobStreams(options: JobStreamOptions): JobStreams {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_JOB_HEARTBEAT_MS;
  const live = new Set<() => void>();

  return {
    open(request, response, owner, jobId, status) {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-content-type-options': 'nosniff',
        // No CORS header. See the note at the top of `event-stream.ts` before adding one.
      });

      let closed = false;

      const write = (frame: string): void => {
        if (closed || response.writableEnded || response.destroyed) return;
        response.write(frame);
      };

      const listener = (event: JobChanged): void => write(frameFor(event));
      const unsubscribe = options.subscriber.subscribe(owner, jobId, listener);

      const heartbeat = setInterval(() => write(': heartbeat\n\n'), heartbeatMs);
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
      request.on('close', close);
      response.on('error', close);

      // The catch-up frame: opening the connection is the re-read trigger. A stream opened on an
      // already-terminal job gets that terminal status immediately and can close on it.
      write(frameFor({ jobId, status }));

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
 * One SSE frame. The event name is `progress` for every job frame — the *kind* of thing on this
 * stream is "a job's progress", and the status that changed rides in `data` where a client reads it.
 * `data:` is one line because `JSON.stringify` escapes any newline a job id could carry (an id is
 * server-minted here, but keeping the same discipline as the score stream costs nothing).
 */
function frameFor(event: JobChanged): string {
  return `event: progress\ndata: ${JSON.stringify(event)}\n\n`;
}
