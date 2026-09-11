import type { Id } from '@sibei/model';
import type { Applier } from '../ops/applier.js';
import type { Owner, ScoreLibrary } from '../store/repository.js';

/**
 * The change bus: an in-process fan-out of "this score moved", so an open score view can repaint
 * when something *else* edited it (SLICES.md V4 step 5).
 *
 * Transport-agnostic on purpose. This file knows nothing about HTTP or about SSE framing — that is
 * `http/event-stream.ts` — because the thing being modelled is "a write happened", and the wire it
 * is announced on is a separate decision that has already changed once in this project's plans
 * (V10 wants a job stream on the same mechanism, ADR-0001).
 *
 * **It comes in halves, for the reason the store port does** (ADR-0003). `ChangePublisher` is the
 * capability to say a score changed; `ChangeSubscriber` is the capability to hear it. `server.ts`
 * is the only file holding both, and it hands the routes the subscriber alone — so a route handler
 * cannot announce a change it did not make, in the same way it cannot make one.
 *
 * **Nothing here can write to a score.** The publisher is fed by *wrapping* the applier rather than
 * by being handed to it, which keeps `applier.ts` — the one file besides the port that may name a
 * `ScoreWriter` — untouched by this slice. A bus that had to be plumbed *into* the writer would be
 * a second reason for something to hold one.
 */

/**
 * A score's document moved to a new version. **The payload is deliberately not the change.**
 *
 * It carries the new `version` and nothing else, and that is the whole shape. The applier already
 * returns `changed[]`, and it was considered here and left out: a client cannot repaint from a list
 * of ids, because it does not have the new *content* — so `changed[]` could never save the re-read,
 * only narrow the redraw after it. What it *would* do is invite a client to treat the event stream
 * as the source of truth, and then a client that missed one event is silently wrong forever.
 *
 * So the contract is: an event says *what version exists now*, and the client's recovery is to
 * re-read if that is not the version it holds. That is idempotent, and it survives a missed event, a
 * duplicated event and a reconnection without any of them being special cases. `/v1/` goes
 * additive-only after the hosted transition (ADR-0022), so this is the shape worth freezing — and
 * `changed[]` stays available to add later if something ever genuinely needs it.
 */
export interface ScoreChanged {
  kind: 'changed';
  scoreId: Id;
  version: number;
}

/**
 * A score left the library. Not an operation and it cannot be — deleting a score destroys the log
 * an entry would live in (ADR-0003) — but it is exactly as much "an external change" as an edit is,
 * and without it a browser holding a deleted chart open waits for an event that can never arrive.
 *
 * No version: there is no document left to be at a version.
 */
export interface ScoreDeleted {
  kind: 'deleted';
  scoreId: Id;
}

/**
 * The event vocabulary. Two members, both decided rather than accumulated, because the wire names
 * are `event:` field values and this is an API that freezes.
 */
export type ChangeEvent = ScoreChanged | ScoreDeleted;

export type ChangeListener = (event: ChangeEvent) => void;

/** The write half: saying a score changed. Held by `server.ts` and by the wrappers below. */
export interface ChangePublisher {
  publish(owner: Owner, event: ChangeEvent): void;
}

/** The read half: hearing about one score's changes. Anything may hold one. */
export interface ChangeSubscriber {
  /** Returns the unsubscribe. Calling it twice is harmless. */
  subscribe(owner: Owner, scoreId: Id, listener: ChangeListener): () => void;
}

export interface ChangeBus extends ChangePublisher, ChangeSubscriber {}

export interface ChangeBusOptions {
  /**
   * Where a listener's failure goes. Reported rather than swallowed, but **never re-thrown**: the
   * publish happens after a write has already landed, so a broken subscriber must not be able to
   * turn a successful edit into a 500. Taken as a callback rather than a `Logger` so this file
   * stays clear of the HTTP layer.
   */
  onError?: (error: unknown) => void;
}

/**
 * The bus. In-process and nothing more — a single-user local app has one server process (ADR-0001),
 * so a broker would be infrastructure bought for a problem that does not exist. When the hosted
 * transition needs cross-process fan-out, this interface is what it replaces.
 */
export function createChangeBus(options: ChangeBusOptions = {}): ChangeBus {
  // Keyed by owner *and* id. Every store query filters on the owner anyway (R8), and an event
  // stream that did not would be the one place a principal could learn about another's library.
  const listeners = new Map<string, Set<ChangeListener>>();
  const keyOf = (owner: Owner, scoreId: Id): string => `${owner} ${scoreId}`;

  return {
    publish(owner, event) {
      const subscribed = listeners.get(keyOf(owner, event.scoreId));
      if (subscribed === undefined) return;
      // A copy: a listener may unsubscribe itself while being told, which a live iteration would
      // not survive.
      for (const listener of [...subscribed]) {
        try {
          listener(event);
        } catch (error) {
          options.onError?.(error);
        }
      }
    },

    subscribe(owner, scoreId, listener) {
      const key = keyOf(owner, scoreId);
      const subscribed = listeners.get(key) ?? new Set<ChangeListener>();
      listeners.set(key, subscribed);
      subscribed.add(listener);
      return () => {
        subscribed.delete(listener);
        // Drop the empty set rather than leaving it: a long-running server that opened a stream per
        // score once would otherwise keep a key per score it has ever seen.
        if (subscribed.size === 0) listeners.delete(key);
      };
    },
  };
}

/**
 * The applier, announcing what it did.
 *
 * A wrapper rather than a constructor argument, for two reasons. It leaves `applier.ts` exactly as
 * it was, so `tests/arch/one-writer.test.ts` is measuring the same thing it was before this slice —
 * publication is not a reason for anything new to name a `ScoreWriter`. And it wraps whatever
 * applier `server.ts` was given, including an injected test double, so the stream cannot be live for
 * the real applier and dead for a fake one.
 *
 * The publish is **after** the apply returns, so a batch that threw announces nothing, and a
 * subscriber that immediately re-reads sees the version it was told about.
 */
export function publishingApplier(applier: Applier, publisher: ChangePublisher): Applier {
  return {
    apply(owner, scoreId, batch) {
      const result = applier.apply(owner, scoreId, batch);
      publisher.publish(owner, {
        kind: 'changed',
        scoreId: result.scoreId,
        version: result.version,
      });
      return result;
    },

    // Undo and redo move the document, so an open view must repaint the same way an edit makes it
    // (V8a). A move that did nothing — the undo floor or the redo head — bumps no version and
    // announces nothing, the same way a 404 delete is not an event.
    undo(owner, scoreId, expectedVersion) {
      return publishMove(applier.undo(owner, scoreId, expectedVersion), owner, publisher);
    },
    redo(owner, scoreId, expectedVersion) {
      return publishMove(applier.redo(owner, scoreId, expectedVersion), owner, publisher);
    },

    // Duplicate creates a *new* score, and the change bus is per-score (subscribers key on an id
    // they already hold open), so a brand-new id has no one to tell — the library that asked
    // re-reads its own list. A pass-through, published to nobody, is the honest wiring.
    duplicate(owner, scoreId, newId) {
      return applier.duplicate(owner, scoreId, newId);
    },

    // Import creates a *new* score, so like duplicate it has no open subscriber to tell — the job
    // stream is what tells the client its import finished, and the client then opens the new id. A
    // pass-through, published to nobody, is the honest wiring (V11).
    import(owner, document) {
      return applier.import(owner, document);
    },
  };
}

function publishMove<T extends { moved: boolean; scoreId: Id; version: number }>(
  result: T,
  owner: Owner,
  publisher: ChangePublisher,
): T {
  if (result.moved) {
    publisher.publish(owner, { kind: 'changed', scoreId: result.scoreId, version: result.version });
  }
  return result;
}

/** The same, for the one mutation that is not an operation (ADR-0003). */
export function publishingLibrary(library: ScoreLibrary, publisher: ChangePublisher): ScoreLibrary {
  return {
    delete(owner, id) {
      const deleted = library.delete(owner, id);
      // Only on a real deletion. A 404 is not an event.
      if (deleted) publisher.publish(owner, { kind: 'deleted', scoreId: id });
      return deleted;
    },
  };
}
