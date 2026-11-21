import type { IncomingMessage } from 'node:http';
import type { Owner } from '../store/repository.js';
import { QuotaError } from './errors.js';
import { memoryRateLimiter } from './rate-limiter.js';
import type { RateLimiter, RateVerdict } from './rate-limiter.js';

/**
 * Rate limits and quotas for the hosted API (V23, ADR-0034 decision 7).
 *
 * Three different things, kept apart because they answer different questions:
 *
 *   - **per-IP** limits (plus one global ceiling) run *before* authentication and bound what an anonymous caller (or a sign-in
 *     loop) can cost. A tighter one covers `/v1/auth/`.
 *   - **per-user** limits run after, by **class** of request (`read`, `write`, `export`, `import`).
 *   - **quotas** bound how much a user may hold or consume: scores, import pages and bytes per day, and
 *     concurrent event streams (KAN-602).
 *
 * Every number is configuration (`LimitsConfig`, `limitsFromEnv`) and every default is deliberately
 * conservative — an abuse brake, not a pricing tier; tune them against real use (ADR-0034, open items).
 *
 * ### Opting a route in
 *
 * A request is classified by `classify` from a **rule table**. Anything not named is `read` for a safe
 * method and `write` otherwise, so a new route is limited by default and needs no edit here. A route that
 * wants its own budget adds a rule and a class to `LimitsConfig.rates`; one that is not a user's at all
 * (a worker polling with its own token) is `exempt`. Health is always exempt.
 */

/** A request class, and the limit that class gets per user. */
export type RequestClass = string;

export interface Rate {
  limit: number;
  windowMs: number;
}

export interface LimitsConfig {
  /** Per-IP, every non-exempt request. An IPv6 address is keyed on its /64 (SEC M5). */
  ip: Rate;
  /** All callers together, every non-exempt request: the ceiling a distributed flood meets (SEC M5). */
  global?: Rate;
  /** Per-IP, failed `sbsw_` worker authentications, which `/v1/worker/` otherwise exempts (SEC M2/M5). */
  workerFailIp?: Rate;
  /** Per-IP, `/v1/auth/*` only: sign-in and device-flow endpoints, which are public by nature. */
  authIp: Rate;
  /** Per-user, by class. A class with no entry here is not limited per user. */
  rates: Record<RequestClass, Rate>;
  quotas: {
    /** Scores a user may hold. Standing: refused on create/duplicate/import once reached. */
    maxScores: number;
    /** Import pages (images) per rolling day. Re-parse counts again: it costs the worker the same. */
    importPagesPerDay: number;
    /** Uploaded import bytes per rolling day. */
    importBytesPerDay: number;
    /** Concurrent SSE streams one user may hold open in this process (KAN-602). */
    maxStreams: number;
  };
  /**
   * Take the client address from the *rightmost* `X-Forwarded-For` entry (the one our own reverse proxy
   * appended) instead of the socket's. Off unless the deployment says a proxy fronts it: trusting the
   * header on a directly exposed server lets any caller pick its own address and walk round the limit.
   */
  trustProxy: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_LIMITS: LimitsConfig = {
  ip: { limit: 600, windowMs: MINUTE },
  global: { limit: 6000, windowMs: MINUTE },
  workerFailIp: { limit: 30, windowMs: MINUTE },
  authIp: { limit: 30, windowMs: MINUTE },
  rates: {
    read: { limit: 300, windowMs: MINUTE },
    write: { limit: 120, windowMs: MINUTE },
    export: { limit: 20, windowMs: MINUTE },
    import: { limit: 10, windowMs: HOUR },
  },
  quotas: {
    maxScores: 200,
    importPagesPerDay: 30,
    importBytesPerDay: 100 * 1024 * 1024,
    maxStreams: 8,
  },
  trustProxy: false,
};

/** Names a request's class, `exempt`, or declines with `undefined`. */
export type Classifier = (method: string, path: string) => RequestClass | undefined;

/**
 * The rule table. First match wins. Routes added by later slices (the audio worker endpoints, `/mcp`)
 * opt in by appearing here, or by not appearing, which is `read`/`write` by method.
 */
export const DEFAULT_CLASSIFIERS: readonly Classifier[] = [
  (_method, path) => (path === '/v1/health' ? 'exempt' : undefined),
  // A worker authenticates with its own token and is not a user; it polls on a schedule (ADR-0034).
  (_method, path) => (path.startsWith('/v1/worker/') ? 'exempt' : undefined),
  (method, path) =>
    method === 'POST' && (path === '/v1/imports' || /^\/v1\/scores\/[^/]+\/reparse$/.test(path)) ? 'import' : undefined,
  (method, path) => (method === 'GET' && /^\/v1\/scores\/[^/]+\/export$/.test(path) ? 'export' : undefined),
];

export function classify(method: string, path: string, classifiers: readonly Classifier[] = DEFAULT_CLASSIFIERS): RequestClass {
  const m = method.toUpperCase();
  for (const rule of classifiers) {
    const found = rule(m, path);
    if (found !== undefined) return found;
  }
  return m === 'GET' || m === 'HEAD' ? 'read' : 'write';
}

/** The request's address for limiting. See `LimitsConfig.trustProxy`. */
export function clientAddress(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const value = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : forwarded;
    const last = value?.split(',').pop()?.trim();
    if (last !== undefined && last !== '') return addressBucket(last);
  }
  return addressBucket(request.socket.remoteAddress ?? 'unknown');
}

/**
 * The key an address is limited by. An IPv4 address is its own bucket; an IPv6 one is its /64, since a
 * single subscriber is routinely handed a whole /64 and keying on the full address gives it 2^64 buckets
 * (SEC M5). An IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) is the IPv4 one.
 */
export function addressBucket(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped !== null) return mapped[1]!;
  if (!address.includes(':')) return address;
  const zone = address.split('%')[0]!;
  const [head = '', tail] = zone.split('::');
  const front = head === '' ? [] : head.split(':');
  const back = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups = tail === undefined ? front : [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill('0'), ...back];
  const prefix = groups.slice(0, 4).map((g) => (g === '' ? '0' : g.toLowerCase().replace(/^0+(?=.)/, '')));
  return `${prefix.join(':')}::/64`;
}

/** A request refused for speed (`429`). */
export interface LimitRefusal {
  scope: 'ip' | 'auth-ip' | 'user';
  class: RequestClass;
  limit: number;
  retryAfterSeconds: number;
}

export interface LimitsOptions {
  config?: LimitsConfig;
  limiter?: RateLimiter;
  classifiers?: readonly Classifier[];
  /** Where a limiter failure goes. The limits fail **open**: they protect the service and must not take it down. */
  onError?: (message: string, error: unknown) => void;
  now?: () => number;
}

export interface Limits {
  readonly config: LimitsConfig;
  /** Before authentication. `null` means admitted. */
  gateAddress(request: IncomingMessage): Promise<LimitRefusal | null>;
  /** After authentication. */
  gateUser(request: IncomingMessage, owner: Owner): Promise<LimitRefusal | null>;
  /** Charge one request of a named class to a user without a request's path to classify (`/mcp`, per tool). */
  gateClass(owner: Owner, cls: RequestClass): Promise<LimitRefusal | null>;
  /** A worker request just failed authentication. Counts it, and says so once the address has had too many. */
  workerAuthFailed(request: IncomingMessage): Promise<LimitRefusal | null>;
  /** Throws `QuotaError` when a user already holding `held` scores has no room for one more. */
  checkScoreRoom(held: number): void;
  /** Spend import pages and bytes from today's budget; throws `QuotaError` when it is exhausted. */
  spendImport(owner: Owner, pages: number, bytes: number): Promise<void>;
  /** Take a stream slot, or throw. Call the returned function once when the stream ends. */
  openStream(owner: Owner): () => void;
}

export function createLimits(options: LimitsOptions = {}): Limits {
  const config = options.config ?? DEFAULT_LIMITS;
  const limiter = options.limiter ?? memoryRateLimiter(options.now === undefined ? {} : { now: options.now });
  const classifiers = options.classifiers ?? DEFAULT_CLASSIFIERS;
  const streams = new Map<string, number>();

  /**
   * Fail-open or fail-closed when the counter errors (SEC M5). Reads fail **open**: the limits protect the
   * service and must not take reading down with a Redis blip. Anything that writes, spends or signs in fails
   * **closed** — refused for a few seconds — because a limiter outage is exactly when an attacker would
   * otherwise get unmetered writes and sign-in guesses.
   */
  async function consume(key: string, cost: number, rate: Rate, failClosed = false): Promise<RateVerdict | null> {
    try {
      return await limiter.consume(key, cost, rate.limit, rate.windowMs);
    } catch (error) {
      options.onError?.(`a rate-limit counter failed; ${failClosed ? 'refusing' : 'admitting'} the request`, error);
      return failClosed ? { allowed: false, limit: rate.limit, remaining: 0, retryAfterMs: 5000 } : null;
    }
  }

  const refusal = (verdict: RateVerdict | null, scope: LimitRefusal['scope'], cls: RequestClass): LimitRefusal | null =>
    verdict === null || verdict.allowed
      ? null
      : { scope, class: cls, limit: verdict.limit, retryAfterSeconds: Math.max(1, Math.ceil(verdict.retryAfterMs / 1000)) };

  const hours = (ms: number): number => Math.max(1, Math.ceil(ms / HOUR));

  async function gateClass(owner: Owner, cls: RequestClass): Promise<LimitRefusal | null> {
    const rate = config.rates[cls];
    if (rate === undefined) return null;
    return refusal(await consume(`user:${owner}:${cls}`, 1, rate, cls !== 'read'), 'user', cls);
  }

  return {
    config,

    async gateAddress(request) {
      const path = (request.url ?? '/').split('?')[0]!;
      if (classify(request.method ?? 'GET', path, classifiers) === 'exempt') return null;
      const address = clientAddress(request, config.trustProxy);
      const method = (request.method ?? 'GET').toUpperCase();
      const closed = method !== 'GET' && method !== 'HEAD';
      const overall = refusal(await consume('global', 1, config.global ?? DEFAULT_LIMITS.global!, closed), 'ip', 'global');
      if (overall !== null) return overall;
      if (path.startsWith('/v1/auth/')) {
        const tight = refusal(await consume(`ip-auth:${address}`, 1, config.authIp, true), 'auth-ip', 'auth');
        if (tight !== null) return tight;
      }
      return refusal(await consume(`ip:${address}`, 1, config.ip, closed), 'ip', 'any');
    },

    async gateUser(request, owner) {
      const path = (request.url ?? '/').split('?')[0]!;
      const cls = classify(request.method ?? 'GET', path, classifiers);
      if (cls === 'exempt') return null;
      return gateClass(owner, cls);
    },

    gateClass,

    async workerAuthFailed(request) {
      const rate = config.workerFailIp ?? DEFAULT_LIMITS.workerFailIp!;
      return refusal(await consume(`ip-worker-fail:${clientAddress(request, config.trustProxy)}`, 1, rate, true), 'ip', 'worker-auth');
    },

    checkScoreRoom(held) {
      if (held >= config.quotas.maxScores) {
        throw new QuotaError(
          'scores',
          config.quotas.maxScores,
          `this account holds ${held} scores, which is the limit (${config.quotas.maxScores}); delete one to make room`,
        );
      }
    },

    async spendImport(owner, pages, bytes) {
      const pagesVerdict = await consume(`quota:pages:${owner}`, pages, { limit: config.quotas.importPagesPerDay, windowMs: DAY });
      if (pagesVerdict !== null && !pagesVerdict.allowed) {
        throw new QuotaError(
          'import-pages',
          config.quotas.importPagesPerDay,
          `the daily import limit of ${config.quotas.importPagesPerDay} pages is used up; it resets in about ${hours(pagesVerdict.retryAfterMs)} hour(s)`,
          Math.ceil(pagesVerdict.retryAfterMs / 1000),
        );
      }
      const bytesVerdict = await consume(`quota:bytes:${owner}`, bytes, { limit: config.quotas.importBytesPerDay, windowMs: DAY });
      if (bytesVerdict !== null && !bytesVerdict.allowed) {
        throw new QuotaError(
          'import-bytes',
          config.quotas.importBytesPerDay,
          `the daily upload limit of ${Math.round(config.quotas.importBytesPerDay / 1024 / 1024)} MB is used up; it resets in about ${hours(bytesVerdict.retryAfterMs)} hour(s)`,
          Math.ceil(bytesVerdict.retryAfterMs / 1000),
        );
      }
    },

    openStream(owner) {
      const held = streams.get(owner) ?? 0;
      if (held >= config.quotas.maxStreams) {
        throw new QuotaError(
          'streams',
          config.quotas.maxStreams,
          `this account already has ${held} live-update streams open (limit ${config.quotas.maxStreams}); close a tab and retry`,
        );
      }
      streams.set(owner, held + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (streams.get(owner) ?? 1) - 1;
        if (remaining <= 0) streams.delete(owner);
        else streams.set(owner, remaining);
      };
    },
  };
}
