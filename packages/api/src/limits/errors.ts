/**
 * A per-user quota was reached (V23). Thrown from inside a service and turned into a structured problem
 * (`403 quota-exceeded`, with the quota's name, limit and — where it resets — a retry hint) at the top of
 * the handler, so a route needs no special case to refuse one.
 *
 * Distinct from a rate limit (`429 rate-limited`): a rate limit is about *how fast*, and waiting a minute
 * fixes it; a quota is about *how much*, and only deleting something (or, for the daily ones, the window
 * rolling over) fixes it.
 */
export type QuotaName = 'scores' | 'import-pages' | 'import-bytes' | 'streams';

export class QuotaError extends Error {
  constructor(
    readonly quota: QuotaName,
    readonly limit: number,
    message: string,
    /** For a windowed quota: seconds until it resets. Absent for a standing one (the score count). */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'QuotaError';
  }
}
