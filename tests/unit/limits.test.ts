import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, QuotaError, classify, clientAddress, createLimits, limitsFromEnv, memoryRateLimiter } from '@sibei/api';

/** Rate limits and quotas (V23): the policy, with no server around it. */

const fakeRequest = (method: string, url: string, headers: Record<string, string> = {}, remote = '203.0.113.9'): IncomingMessage =>
  ({ method, url, headers, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;

describe('the in-memory counter', () => {
  it('admits up to the limit, refuses past it without counting the refusal, and resets with the window', async () => {
    let now = 1_000;
    const limiter = memoryRateLimiter({ now: () => now });
    expect((await limiter.consume('k', 1, 2, 1000)).allowed).toBe(true);
    expect((await limiter.consume('k', 1, 2, 1000)).remaining).toBe(0);
    const refused = await limiter.consume('k', 1, 2, 1000);
    expect(refused).toMatchObject({ allowed: false, retryAfterMs: 1000 });
    now += 600;
    expect((await limiter.consume('k', 1, 2, 1000)).retryAfterMs).toBe(400);
    now += 400;
    expect((await limiter.consume('k', 1, 2, 1000)).allowed).toBe(true);
  });

  it('charges a cost, and refuses a cost that does not fit whole', async () => {
    const limiter = memoryRateLimiter();
    expect((await limiter.consume('pages', 3, 5, 1000)).allowed).toBe(true);
    expect((await limiter.consume('pages', 3, 5, 1000)).allowed).toBe(false);
    expect((await limiter.consume('pages', 2, 5, 1000)).allowed).toBe(true);
  });

  it('keeps keys apart', async () => {
    const limiter = memoryRateLimiter();
    await limiter.consume('a', 1, 1, 1000);
    expect((await limiter.consume('b', 1, 1, 1000)).allowed).toBe(true);
  });
});

describe('classifying a request', () => {
  it.each([
    ['GET', '/v1/health', 'exempt'],
    ['GET', '/v1/worker/claim', 'exempt'],
    ['GET', '/v1/scores', 'read'],
    ['POST', '/v1/scores/x/ops', 'write'],
    ['DELETE', '/v1/scores/x', 'write'],
    ['POST', '/v1/imports', 'import'],
    ['POST', '/v1/scores/x/reparse', 'import'],
    ['GET', '/v1/scores/x/export', 'export'],
    // not named, so limited by method: a new route needs no edit to be covered
    ['POST', '/mcp', 'write'],
    ['GET', '/v1/something-new', 'read'],
  ])('%s %s is %s', (method, path, expected) => {
    expect(classify(method, path)).toBe(expected);
  });
});

describe('the client address', () => {
  it('is the socket by default, and ignores a forged X-Forwarded-For', () => {
    expect(clientAddress(fakeRequest('GET', '/', { 'x-forwarded-for': '1.2.3.4' }), false)).toBe('203.0.113.9');
  });
  it('is the rightmost forwarded entry behind a trusted proxy, so a client cannot choose its own', () => {
    expect(clientAddress(fakeRequest('GET', '/', { 'x-forwarded-for': '6.6.6.6, 198.51.100.7' }), true)).toBe('198.51.100.7');
  });
});

describe('the limits', () => {
  const tight = {
    ...DEFAULT_LIMITS,
    ip: { limit: 3, windowMs: 60_000 },
    authIp: { limit: 1, windowMs: 60_000 },
    rates: { ...DEFAULT_LIMITS.rates, write: { limit: 2, windowMs: 60_000 } },
    quotas: { ...DEFAULT_LIMITS.quotas, maxScores: 2, importPagesPerDay: 4, maxStreams: 1 },
  };

  it('limits an address, but never the health check', async () => {
    const limits = createLimits({ config: tight });
    for (let i = 0; i < 3; i++) expect(await limits.gateAddress(fakeRequest('GET', '/v1/scores'))).toBeNull();
    expect(await limits.gateAddress(fakeRequest('GET', '/v1/scores'))).toMatchObject({ scope: 'ip', limit: 3 });
    expect(await limits.gateAddress(fakeRequest('GET', '/v1/health'))).toBeNull();
  });

  it('holds the sign-in routes to the tighter limit', async () => {
    const limits = createLimits({ config: tight });
    expect(await limits.gateAddress(fakeRequest('GET', '/v1/auth/github/login'))).toBeNull();
    const refused = await limits.gateAddress(fakeRequest('GET', '/v1/auth/github/login'));
    expect(refused).toMatchObject({ scope: 'auth-ip', limit: 1 });
    expect(refused?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('limits a user by class, per user', async () => {
    const limits = createLimits({ config: tight });
    const write = fakeRequest('POST', '/v1/scores/x/ops');
    expect(await limits.gateUser(write, 'usr_a')).toBeNull();
    expect(await limits.gateUser(write, 'usr_a')).toBeNull();
    expect(await limits.gateUser(write, 'usr_a')).toMatchObject({ scope: 'user', class: 'write' });
    expect(await limits.gateUser(write, 'usr_b')).toBeNull();
    expect(await limits.gateUser(fakeRequest('GET', '/v1/scores'), 'usr_a')).toBeNull();
  });

  it('fails open when the counter fails, and says so', async () => {
    const errors: string[] = [];
    const limits = createLimits({
      config: tight,
      limiter: { consume: () => Promise.reject(new Error('redis is away')) },
      onError: (message) => void errors.push(message),
    });
    expect(await limits.gateAddress(fakeRequest('GET', '/v1/scores'))).toBeNull();
    expect(errors).toHaveLength(2); // the global counter and the per-IP one both failed (SEC M5)
  });

  it('refuses a score past the quota, naming it', () => {
    const limits = createLimits({ config: tight });
    limits.checkScoreRoom(1);
    expect(() => limits.checkScoreRoom(2)).toThrow(QuotaError);
  });

  it('spends import pages from a daily budget and reports when it resets', async () => {
    const limits = createLimits({ config: tight });
    await limits.spendImport('usr_a', 3, 10);
    const error = await limits.spendImport('usr_a', 2, 10).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuotaError);
    expect(error).toMatchObject({ quota: 'import-pages', limit: 4 });
    expect((error as QuotaError).retryAfterSeconds).toBeGreaterThan(0);
    await limits.spendImport('usr_b', 4, 10);
  });

  it('caps concurrent streams per user and frees the slot once, however many times it is released', () => {
    const limits = createLimits({ config: tight });
    const release = limits.openStream('usr_a');
    expect(() => limits.openStream('usr_a')).toThrow(QuotaError);
    limits.openStream('usr_b')();
    release();
    release();
    limits.openStream('usr_a');
  });
});

describe('limits from the environment', () => {
  it('is the defaults with nothing set', () => {
    expect(limitsFromEnv({})).toEqual(DEFAULT_LIMITS);
  });
  it('takes each number from its variable', () => {
    const config = limitsFromEnv({
      SBSCORE_LIMIT_IP_PER_MIN: '10',
      SBSCORE_LIMIT_USER_IMPORT_PER_HOUR: '2',
      SBSCORE_QUOTA_MAX_SCORES: '5',
      SBSCORE_QUOTA_IMPORT_MB_PER_DAY: '1',
      SBSCORE_TRUST_PROXY: 'true',
    });
    expect(config.ip.limit).toBe(10);
    expect(config.rates.import?.limit).toBe(2);
    expect(config.quotas.maxScores).toBe(5);
    expect(config.quotas.importBytesPerDay).toBe(1024 * 1024);
    expect(config.trustProxy).toBe(true);
  });
  it('rejects a malformed number by name instead of falling back', () => {
    expect(() => limitsFromEnv({ SBSCORE_QUOTA_MAX_SCORES: 'lots' })).toThrow(/SBSCORE_QUOTA_MAX_SCORES/);
    expect(() => limitsFromEnv({ SBSCORE_LIMIT_IP_PER_MIN: '0' })).toThrow(/SBSCORE_LIMIT_IP_PER_MIN/);
  });
});
