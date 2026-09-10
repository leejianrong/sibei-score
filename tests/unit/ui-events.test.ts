import { CHANGED, DELETED, watchScore } from '@sibei/ui';
import { describe, expect, it, vi } from 'vitest';

/**
 * `watchScore` — the browser end of the change stream (V4d, SLICES.md V4 step 5).
 *
 * A fake `EventSource` stands in for the real one (which is a DOM global the fast layer does not
 * have), so what is under test is this module's parsing and forwarding — not the browser. It is
 * deliberately a transport: it reads `{version}` off a frame and hands it on, and every decision
 * about whether that version is *news* lives in `ScoreView.svelte`, which the stack E2E covers.
 */

interface FakeSource {
  url: string;
  closed: boolean;
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
  /** Test-only: deliver a frame of the given `event:` type. */
  emit(type: string, data: string): void;
}

function fakeSources(): { made: FakeSource[]; make: (url: string) => FakeSource } {
  const made: FakeSource[] = [];
  const make = (url: string): FakeSource => {
    const listeners = new Map<string, (event: { data: string }) => void>();
    const source: FakeSource = {
      url,
      closed: false,
      addEventListener: (type, listener) => listeners.set(type, listener),
      close() {
        this.closed = true;
      },
      emit(type, data) {
        listeners.get(type)?.({ data });
      },
    };
    made.push(source);
    return source;
  };
  return { made, make };
}

describe('watchScore', () => {
  it('opens the stream at the score events path, with the id encoded', () => {
    const { made, make } = fakeSources();
    watchScore('score/1', { onChanged: () => {}, onDeleted: () => {} }, make);
    expect(made).toHaveLength(1);
    expect(made[0]?.url).toBe('/v1/scores/score%2F1/events');
  });

  it('forwards a changed frame version to onChanged', () => {
    const { made, make } = fakeSources();
    const onChanged = vi.fn();
    watchScore('s1', { onChanged, onDeleted: () => {} }, make);

    made[0]?.emit(CHANGED, JSON.stringify({ scoreId: 's1', version: 7 }));

    expect(onChanged).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('calls onDeleted for a deleted frame, with no version to carry', () => {
    const { made, make } = fakeSources();
    const onDeleted = vi.fn();
    watchScore('s1', { onChanged: () => {}, onDeleted }, make);

    made[0]?.emit(DELETED, JSON.stringify({ scoreId: 's1' }));

    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it('swallows a malformed changed frame rather than throwing out of a listener', () => {
    const { made, make } = fakeSources();
    const onChanged = vi.fn();
    watchScore('s1', { onChanged, onDeleted: () => {} }, make);

    expect(() => made[0]?.emit(CHANGED, 'not json')).not.toThrow();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('ignores a changed frame whose version is not a number', () => {
    const { made, make } = fakeSources();
    const onChanged = vi.fn();
    watchScore('s1', { onChanged, onDeleted: () => {} }, make);

    made[0]?.emit(CHANGED, JSON.stringify({ scoreId: 's1' }));

    expect(onChanged).not.toHaveBeenCalled();
  });

  it('closes the source when the returned teardown runs', () => {
    const { made, make } = fakeSources();
    const stop = watchScore('s1', { onChanged: () => {}, onDeleted: () => {} }, make);
    expect(made[0]?.closed).toBe(false);
    stop();
    expect(made[0]?.closed).toBe(true);
  });
});
