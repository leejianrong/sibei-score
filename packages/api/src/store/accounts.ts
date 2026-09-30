/**
 * The account port (V20, ADR-0034 decision 3): users, the provider identities that resolve to them, and
 * the sessions that prove a browser is one of them.
 *
 * It is a port of its own — not more methods on `ScoreStore` — for the reason `JobStore` is: an account
 * is not a score. `ScoreStore` is the append-only op log and its single writer (ADR-0003); a mutable
 * session row has no business behind that door. Asynchronous throughout (`tests/arch/async-ports.test.ts`).
 *
 * **What the store never sees is a raw secret.** A session token is 256 random bits handed to the browser
 * once; the store keeps only its SHA-256 (`tokenHash`), so a leaked database or backup cannot be replayed as
 * a login. Hashing is the caller's job (`http/session-token.ts`), which keeps the adapters ignorant of the
 * scheme and the conformance suite able to name its own hashes.
 *
 * **A user is keyed by an internal id, never by the provider's login** (a GitHub login can be renamed, and
 * handed to a different person). The id is what every row's `owner` becomes. The provider's stable
 * `subject` (GitHub's numeric id) maps to it through `identities`, so a second provider adds rows, not a
 * redesign.
 */

/** An internal identifier: opaque, never derived from a provider. It is a row's `owner` when hosted. */
export type UserId = string;

export interface User {
  id: UserId;
  /** Refreshed from the provider at every sign-in. Display only; never an identity. */
  displayName: string;
  avatarUrl: string | null;
  /** ISO-8601, second resolution, like every stored timestamp. */
  createdAt: string;
}

/** What a provider told us about someone who just proved who they are. */
export interface ProviderProfile {
  /** `github`. A small closed vocabulary that grows one word per provider. */
  provider: string;
  /** The provider's *stable* id for the person (GitHub's numeric id), as text. Never the login name. */
  subject: string;
  displayName: string;
  avatarUrl: string | null;
}

/** How long a session lives. Both bounds are enforced by the store on every lookup. */
export interface SessionPolicy {
  /** The absolute lifetime: no amount of activity extends a session past it. */
  ttlMs: number;
  /** How long a session may sit unused before it lapses. Use slides it forward, never past `ttlMs`. */
  idleMs: number;
}

export interface AccountStore {
  /**
   * Find or create the user for a provider identity, and refresh the profile fields. The one place an
   * identity becomes a user, and idempotent under a race: two first sign-ins of the same person at once
   * yield one user. Runs as the system actor — no owner exists yet to scope it to.
   */
  signIn(profile: ProviderProfile): Promise<User>;

  /** A user by id, or `null`. Owner-scoped in Postgres: a caller can read only its own row. */
  getUser(id: UserId): Promise<User | null>;

  /** Record a session for `userId` under the hash of a token the caller has just issued. */
  createSession(userId: UserId, tokenHash: string, policy: SessionPolicy): Promise<void>;

  /**
   * Resolve a token hash to its user, or `null` when it is unknown, expired (absolutely) or idle too long.
   * A lapsed session is deleted on the way out. A live one has its idle deadline slid forward. The
   * lookup is the one thing that happens before any owner is known, so it runs as the system actor.
   */
  resolveSession(tokenHash: string): Promise<User | null>;

  /** End one session (sign out). Ending an unknown one is not an error. */
  deleteSession(tokenHash: string): Promise<void>;

  /** Remove every lapsed session; returns how many. Housekeeping — `resolveSession` is already correct without it. */
  purgeExpiredSessions(): Promise<number>;

  close(): Promise<void>;
}
