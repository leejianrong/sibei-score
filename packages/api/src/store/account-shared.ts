import type { SessionPolicy, User } from './accounts.js';
import { timestamp } from './store-shared.js';

/**
 * The pieces of an account store that are the same whichever database holds it (V20). Like
 * `store-shared.ts`, it names no driver, so it is not one of the files `tests/arch` restricts. Sharing the
 * session arithmetic is what stops the adapters disagreeing about when a session is dead.
 */

/** The columns of a `users` row as every adapter returns them. */
export interface UserRow {
  id: string;
  display_name: string;
  avatar_url: string | null;
  created_at: string;
}

export function toUser(row: UserRow): User {
  return { id: row.id, displayName: row.display_name, avatarUrl: row.avatar_url, createdAt: row.created_at };
}

/** The two deadlines a new session starts with. */
export function sessionDeadlines(now: () => Date, policy: SessionPolicy): { expiresAt: string; idleUntil: string } {
  if (!(policy.ttlMs > 0) || !(policy.idleMs > 0)) {
    throw new Error('a session needs a positive ttlMs and idleMs');
  }
  const base = now().getTime();
  const expires = base + policy.ttlMs;
  return {
    expiresAt: timestamp(() => new Date(expires)),
    // The idle window can never outlive the session.
    idleUntil: timestamp(() => new Date(Math.min(expires, base + policy.idleMs))),
  };
}

/** Whether a session with these deadlines is dead at `at`. Timestamps compare as text (ISO, one zone). */
export function isLapsed(expiresAt: string, idleUntil: string, at: string): boolean {
  return expiresAt <= at || idleUntil <= at;
}

/**
 * The new idle deadline for a session just used, or `null` to leave the row alone.
 *
 * Sliding on every request would turn each read into a write, so the deadline moves only once a quarter of
 * the idle window has been spent. That bounds the write rate to a few per idle window per session, at the
 * cost of a session's idle deadline being up to a quarter-window earlier than "last use + idle". Never
 * moves past the absolute expiry.
 */
export function slidIdleUntil(
  now: () => Date,
  session: { expiresAt: string; idleUntil: string; idleMs: number },
): string | null {
  const at = now().getTime();
  const target = Math.min(Date.parse(session.expiresAt), at + session.idleMs);
  const current = Date.parse(session.idleUntil);
  if (target - current < session.idleMs / 4) return null;
  return timestamp(() => new Date(target));
}
