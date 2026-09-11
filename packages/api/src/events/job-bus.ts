import type { Owner } from '../store/repository.js';
import type { JobId, JobStatus } from '../store/jobs.js';

/**
 * The job change bus: an in-process fan-out of "this import job's status moved", so a client
 * watching an import repaints its progress without polling (ADR-0001: "submit, then poll or
 * subscribe"). The sibling of the score change bus (`change-bus.ts`), which already anticipated this
 * — "V10 wants a job stream on the same mechanism".
 *
 * Same shape and same reasons: transport-agnostic (SSE framing is `http/job-stream.ts`'s job), and
 * **in halves** so the runner holds the publisher and the routes hold only the subscriber. A route
 * handler can watch a job move but cannot announce a move — exactly as it can read a score but not
 * write one.
 *
 * **The payload carries the new status and nothing else**, for the same reason the score event
 * carries only a version: an event is a nudge to re-read, not the source of truth. A client hearing
 * `succeeded` re-reads the job to get the recognised objects; one hearing `failed` re-reads for the
 * diagnostic. So a missed event, a duplicate, or a reconnection all recover by the one idempotent
 * action — re-read the job — and the stream never becomes a thing a client can be silently wrong
 * about. `status` rather than a bare "it changed" because a progress indicator is the whole point of
 * subscribing, and the four statuses are already a closed, frozen vocabulary (`JobStatus`).
 */
export interface JobChanged {
  jobId: JobId;
  status: JobStatus;
}

export type JobListener = (event: JobChanged) => void;

/** The write half: saying a job moved. Held by the runner (and `server.ts`). */
export interface JobPublisher {
  publish(owner: Owner, event: JobChanged): void;
}

/** The read half: hearing about one job's moves. Anything may hold one. */
export interface JobSubscriber {
  /** Returns the unsubscribe. Calling it twice is harmless. */
  subscribe(owner: Owner, jobId: JobId, listener: JobListener): () => void;
}

export interface JobBus extends JobPublisher, JobSubscriber {}

export interface JobBusOptions {
  /** Where a listener's failure goes: reported, never re-thrown (the publish follows a committed write). */
  onError?: (error: unknown) => void;
}

export function createJobBus(options: JobBusOptions = {}): JobBus {
  // Keyed by owner and id, like the score bus: every job read filters on owner (ADR-0001), and a
  // stream that did not would be a place one principal could learn about another's imports.
  const listeners = new Map<string, Set<JobListener>>();
  const keyOf = (owner: Owner, jobId: JobId): string => `${owner} ${jobId}`;

  return {
    publish(owner, event) {
      const subscribed = listeners.get(keyOf(owner, event.jobId));
      if (subscribed === undefined) return;
      for (const listener of [...subscribed]) {
        try {
          listener(event);
        } catch (error) {
          options.onError?.(error);
        }
      }
    },

    subscribe(owner, jobId, listener) {
      const key = keyOf(owner, jobId);
      const subscribed = listeners.get(key) ?? new Set<JobListener>();
      listeners.set(key, subscribed);
      subscribed.add(listener);
      return () => {
        subscribed.delete(listener);
        if (subscribed.size === 0) listeners.delete(key);
      };
    },
  };
}
