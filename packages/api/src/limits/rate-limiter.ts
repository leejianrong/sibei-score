/**
 * The rate-limit counter port (V23, ADR-0034 decision 7).
 *
 * A fixed-window counter keyed by a string, behind a port so the same policy runs on a per-process
 * `Map` (the local default and a single API replica) or on shared counters in Redis
 * (`./redis-rate-limiter.ts`, `@sibei/api/redis`) when a second replica makes "per user" mean "across
 * processes".
 *
 * `consume` is **check-then-add**: a request that would exceed the limit is refused *without* being
 * counted, so a client hammering a closed door does not extend its own lockout, and a quota ("30 import
 * pages a day") is exactly what was used rather than what was attempted.
 *
 * Fixed windows rather than sliding: cheap, atomic in one Redis script, and the burst at a window edge
 * (at most twice the limit) is acceptable for limits that are set conservatively to stop abuse, not to
 * meter anything.
 */
export interface RateVerdict {
  allowed: boolean;
  limit: number;
  /** What is left in this window after the call (0 when refused). */
  remaining: number;
  /** When refused: how long until the window resets. Otherwise 0. */
  retryAfterMs: number;
}

export interface RateLimiter {
  consume(key: string, cost: number, limit: number, windowMs: number): Promise<RateVerdict>;
}

interface Window {
  count: number;
  resetAt: number;
}

export interface MemoryRateLimiterOptions {
  now?: () => number;
}

export function memoryRateLimiter(options: MemoryRateLimiterOptions = {}): RateLimiter {
  const now = options.now ?? Date.now;
  const windows = new Map<string, Window>();
  let sinceSweep = 0;

  return {
    async consume(key, cost, limit, windowMs) {
      const t = now();
      // A bounded sweep, so a long-lived process that has seen many one-off IPs does not keep a key for each.
      if (++sinceSweep >= 1000) {
        sinceSweep = 0;
        for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
      }
      let window = windows.get(key);
      if (window === undefined || window.resetAt <= t) {
        window = { count: 0, resetAt: t + windowMs };
        windows.set(key, window);
      }
      if (window.count + cost > limit) {
        return { allowed: false, limit, remaining: 0, retryAfterMs: Math.max(1, window.resetAt - t) };
      }
      window.count += cost;
      return { allowed: true, limit, remaining: limit - window.count, retryAfterMs: 0 };
    },
  };
}
