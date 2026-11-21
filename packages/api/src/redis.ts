import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { createChangeBus } from './events/change-bus.js';
import type { ChangeBus, ChangeEvent } from './events/change-bus.js';
import { createJobBus } from './events/job-bus.js';
import type { JobBus, JobChanged } from './events/job-bus.js';
import type { RateLimiter } from './limits/rate-limiter.js';
import type { Owner } from './store/repository.js';

/**
 * The Redis adapter, as an opt-in subpath (V23, ADR-0034 decision 8): `@sibei/api/redis`.
 *
 * The sibling of `./sqlite` and `./postgres`, and the only file in the tree that names the Redis driver
 * (`tests/arch/redis-seam.test.ts`). It supplies two things behind ports that already exist:
 *
 *   - the **change bus** and **job bus**, so an SSE client on one API process hears an edit or a job move
 *     made through another; and
 *   - the **rate-limit counters** (`RateLimiter`), so a per-user limit means the same across replicas.
 *
 * Nothing about a *local* install changes: without a Redis URL `sbscore serve` builds the in-process
 * buses and the in-memory limiter, exactly as before.
 *
 * ### How the bus crosses processes
 *
 * Each process keeps its own in-process bus and delivers a local publish to it **directly**, before and
 * regardless of Redis, so a Redis outage cannot make an edit invisible to the tab that made it. The
 * publish is then also sent on one Redis channel per bus, tagged with this process's id; every process
 * (this one included) hears it, ignores its own, and hands the rest to its in-process bus. Events are
 * nudges, not the source of truth (see `change-bus.ts`): the stream's first frame is a catch-up and a
 * client re-reads on any version it does not hold, so Redis pub/sub's at-most-once delivery (a message
 * published while a subscriber is reconnecting is lost) is a missed repaint until the next event or
 * reconnect, never a wrong document.
 */

const CHANGES_CHANNEL = 'sibei:changes';
const JOBS_CHANNEL = 'sibei:jobs';

export interface RedisOptions {
  /** `redis://[:password@]host:port[/db]`. */
  url: string;
  /** Where a Redis failure goes. Reported, never thrown: the bus and the limiter must not fail a request. */
  onError?: (message: string, error: unknown) => void;
  /** How long `openRedis` waits for both connections before giving up. */
  connectTimeoutMs?: number;
}

export interface RedisServices {
  changeBus(options?: { onError?: (error: unknown) => void }): ChangeBus;
  jobBus(options?: { onError?: (error: unknown) => void }): JobBus;
  limiter: RateLimiter;
  /** Round-trips a PING; for a health probe. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Check, then add, in one atomic step: refuse without counting when the call would pass the limit;
 * otherwise add the cost and (on the window's first hit) start its expiry. Returns {allowed, count, ttlMs}.
 */
const CONSUME = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local cost = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if current + cost > limit then
  return {0, current, redis.call('PTTL', KEYS[1])}
end
current = redis.call('INCRBY', KEYS[1], cost)
if current == cost then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
return {1, current, redis.call('PTTL', KEYS[1])}
`;

interface Wire<E> {
  /** The publishing process, so it can ignore its own echo. */
  from: string;
  owner: Owner;
  event: E;
}

export async function openRedis(options: RedisOptions): Promise<RedisServices> {
  const report = options.onError ?? (() => undefined);
  const self = randomUUID();

  // Two connections: a subscribing connection can do nothing else. The command connection fails fast when
  // Redis is away rather than queueing, so a limit check or a publish never stalls a request.
  const commands = new Redis(options.url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: true });
  const subscriber = new Redis(options.url, { lazyConnect: true });
  for (const [name, client] of [['commands', commands], ['subscriber', subscriber]] as const) {
    client.on('error', (error: unknown) => report(`redis ${name} connection error`, error));
  }

  const timeoutMs = options.connectTimeoutMs ?? 5000;
  try {
    await Promise.race([
      Promise.all([commands.connect(), subscriber.connect()]),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer from Redis within ${timeoutMs} ms`)), timeoutMs).unref()),
    ]);
  } catch (error) {
    commands.disconnect();
    subscriber.disconnect();
    throw new Error(`could not connect to Redis (${error instanceof Error ? error.message : String(error)})`);
  }

  const deliver = new Map<string, (owner: Owner, event: never) => void>();
  subscriber.on('message', (channel: string, message: string) => {
    try {
      const wire = JSON.parse(message) as Wire<unknown>;
      if (wire.from === self) return;
      deliver.get(channel)?.(wire.owner, wire.event as never);
    } catch (error) {
      report('a malformed message arrived on a redis channel', error);
    }
  });

  /** Wrap an in-process bus so its publishes also cross processes, and what crosses in is delivered to it. */
  function crossing<E, B extends { publish(owner: Owner, event: E): void }>(local: B, channel: string): B {
    deliver.set(channel, (owner, event) => local.publish(owner, event as E));
    void subscriber.subscribe(channel).catch((error: unknown) => report(`could not subscribe to ${channel}`, error));
    return {
      ...local,
      publish(owner: Owner, event: E) {
        local.publish(owner, event);
        const wire: Wire<E> = { from: self, owner, event };
        commands.publish(channel, JSON.stringify(wire)).catch((error: unknown) => report(`could not publish to ${channel}`, error));
      },
    };
  }

  return {
    changeBus(busOptions = {}) {
      return crossing<ChangeEvent, ChangeBus>(createChangeBus(busOptions), CHANGES_CHANNEL);
    },
    jobBus(busOptions = {}) {
      return crossing<JobChanged, JobBus>(createJobBus(busOptions), JOBS_CHANNEL);
    },
    limiter: {
      async consume(key, cost, limit, windowMs) {
        const [allowed, count, ttl] = (await commands.eval(CONSUME, 1, `sibei:rl:${key}`, cost, limit, windowMs)) as [number, number, number];
        return allowed === 1
          ? { allowed: true, limit, remaining: Math.max(0, limit - count), retryAfterMs: 0 }
          : { allowed: false, limit, remaining: 0, retryAfterMs: Math.max(1, ttl) };
      },
    },
    async ping() {
      await commands.ping();
    },
    async close() {
      commands.disconnect();
      subscriber.disconnect();
    },
  };
}
