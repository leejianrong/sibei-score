import { DEFAULT_LIMITS } from './limits.js';
import type { LimitsConfig, Rate } from './limits.js';

/**
 * `LimitsConfig` from environment variables (V23). Pure: `sbscore serve` passes `process.env`, a test
 * passes an object. Every number has a variable, none is required, and a malformed one is an error
 * naming it; a typo that silently fell back to the default would be a limit nobody meant to leave open.
 *
 *   SBSCORE_LIMIT_IP_PER_MIN            per-IP, all requests            (default 600)
 *   SBSCORE_LIMIT_GLOBAL_PER_MIN        all callers together           (6000)
 *   SBSCORE_LIMIT_WORKER_FAIL_IP_PER_MIN per-IP failed worker auth     (30)
 *   SBSCORE_LIMIT_AUTH_IP_PER_MIN       per-IP, /v1/auth/*              (30)
 *   SBSCORE_LIMIT_USER_READ_PER_MIN     per-user reads                  (300)
 *   SBSCORE_LIMIT_USER_WRITE_PER_MIN    per-user writes                 (120)
 *   SBSCORE_LIMIT_USER_EXPORT_PER_MIN   per-user exports                (20)
 *   SBSCORE_LIMIT_USER_IMPORT_PER_HOUR  per-user import submissions     (10)
 *   SBSCORE_QUOTA_MAX_SCORES            scores held                     (200)
 *   SBSCORE_QUOTA_IMPORT_PAGES_PER_DAY  import pages per day            (30)
 *   SBSCORE_QUOTA_IMPORT_MB_PER_DAY     import megabytes per day        (100)
 *   SBSCORE_QUOTA_EXPORT_CACHE_ENTRIES  cached exports held            (100)
 *   SBSCORE_QUOTA_MAX_STREAMS           concurrent event streams        (8)
 *   SBSCORE_TRUST_PROXY                 `1`/`true`: client address from the proxy's X-Forwarded-For
 */
export function limitsFromEnv(env: Record<string, string | undefined>): LimitsConfig {
  const base = DEFAULT_LIMITS;
  const positive = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive whole number, got ${JSON.stringify(raw)}`);
    }
    return value;
  };
  const rate = (name: string, fallback: Rate): Rate => ({ limit: positive(name) ?? fallback.limit, windowMs: fallback.windowMs });
  const mb = positive('SBSCORE_QUOTA_IMPORT_MB_PER_DAY');
  const proxy = env.SBSCORE_TRUST_PROXY?.toLowerCase();
  return {
    ip: rate('SBSCORE_LIMIT_IP_PER_MIN', base.ip),
    global: rate('SBSCORE_LIMIT_GLOBAL_PER_MIN', base.global!),
    workerFailIp: rate('SBSCORE_LIMIT_WORKER_FAIL_IP_PER_MIN', base.workerFailIp!),
    authIp: rate('SBSCORE_LIMIT_AUTH_IP_PER_MIN', base.authIp),
    rates: {
      read: rate('SBSCORE_LIMIT_USER_READ_PER_MIN', base.rates.read!),
      write: rate('SBSCORE_LIMIT_USER_WRITE_PER_MIN', base.rates.write!),
      export: rate('SBSCORE_LIMIT_USER_EXPORT_PER_MIN', base.rates.export!),
      import: rate('SBSCORE_LIMIT_USER_IMPORT_PER_HOUR', base.rates.import!),
    },
    quotas: {
      maxScores: positive('SBSCORE_QUOTA_MAX_SCORES') ?? base.quotas.maxScores,
      importPagesPerDay: positive('SBSCORE_QUOTA_IMPORT_PAGES_PER_DAY') ?? base.quotas.importPagesPerDay,
      importBytesPerDay: mb === undefined ? base.quotas.importBytesPerDay : mb * 1024 * 1024,
      maxStreams: positive('SBSCORE_QUOTA_MAX_STREAMS') ?? base.quotas.maxStreams,
      maxExportCacheEntries: positive('SBSCORE_QUOTA_EXPORT_CACHE_ENTRIES') ?? base.quotas.maxExportCacheEntries!,
    },
    trustProxy: proxy === '1' || proxy === 'true',
  };
}
