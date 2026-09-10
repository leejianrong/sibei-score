import type { Id } from '@sibei/model';

/**
 * The browser end of the change stream (V4d, SLICES.md V4 step 5): an `EventSource` on
 * `GET /v1/scores/:id/events`, so an open score view repaints when something *else* edited the
 * chart — a CLI `sbscore note set`, or another browser tab.
 *
 * **This module decides nothing about what to do with a change.** It parses the wire and forwards
 * `{version}` on a `changed` and nothing on a `deleted`; the caller compares that version against
 * the one it holds and re-reads if they differ (`ScoreView.svelte`). That is the contract the
 * server froze on purpose (`packages/api/src/events/change-bus.ts`): an event says *what version
 * exists now*, and recovery is "re-read if that is not the version I hold" — idempotent, and the
 * same action whether one event was missed or a hundred. Putting the compare in the caller keeps
 * this file a transport and nothing more.
 *
 * **Same-origin, like every other request** (`api.ts`). The path is relative, so the browser opens
 * the stream against itself and the dev server proxies `/v1` to the API (`vite.config.ts`) — an
 * `EventSource` cannot carry a header to satisfy a CORS check and the API sends none anyway
 * (ADR-0029).
 */

/**
 * The `event:` names the server emits (`http/event-stream.ts`). Two, both frozen — they are wire
 * strings on an API that goes additive-only after the hosted transition (ADR-0022), not an enum
 * to grow casually.
 */
export const CHANGED = 'changed';
export const DELETED = 'deleted';

export interface ScoreWatchHandlers {
  /**
   * A `changed` frame arrived carrying the version that now exists. The stream's **first** frame is
   * always one of these (the server's catch-up frame), carrying the current version, so opening the
   * connection *is* the re-read trigger and a reconnecting client cannot forget to catch up.
   */
  onChanged: (version: number) => void;
  /** The chart left the library. There is no version — there is no document left to be at one. */
  onDeleted: () => void;
}

/**
 * The sliver of `EventSource` this module uses, so a unit test can hand it a fake without a DOM.
 * The real one is a browser global; the default factory below is the only place it is named, and
 * it is a function body, so importing this module in Node (the fast test layer) never touches it.
 */
export interface EventStreamHandle {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
}

export type EventStreamFactory = (url: string) => EventStreamHandle;

const defaultFactory: EventStreamFactory = (url) => new EventSource(url) as EventStreamHandle;

/**
 * Open a stream for one score. Returns the teardown — call it when the view unmounts, so a closed
 * chart does not leave a live connection (and the server's leak assertion stays true).
 *
 * A malformed `data:` payload is swallowed rather than thrown: a frame we cannot parse is exactly
 * the case where "re-read if unsure" is safest, and letting `JSON.parse` throw out of an event
 * listener would take down nothing useful. The version is read straight from the frame; the caller
 * decides whether it is news.
 */
export function watchScore(
  id: Id,
  handlers: ScoreWatchHandlers,
  makeSource: EventStreamFactory = defaultFactory,
): () => void {
  const source = makeSource(`/v1/scores/${encodeURIComponent(id)}/events`);

  source.addEventListener(CHANGED, (event) => {
    let version: unknown;
    try {
      version = (JSON.parse(event.data) as { version?: unknown }).version;
    } catch {
      return;
    }
    if (typeof version === 'number') handlers.onChanged(version);
  });

  source.addEventListener(DELETED, () => handlers.onDeleted());

  return () => source.close();
}
