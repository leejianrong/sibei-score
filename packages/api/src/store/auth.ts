/**
 * The identity port (V20, ADR-0034 decision 3): users, the provider identities that sign them in, and
 * the sessions they hold.
 *
 * **Identity is ours and GitHub is only the login provider.** A user is keyed by an internal id that
 * becomes the `owner` on every row they create, never by a GitHub login (which a person can rename, and
 * which another person can then claim). `identities(provider, subject)` maps a provider's *stable* subject
 * — GitHub's numeric id — to that user, so a second provider is another row and a route, not a redesign.
 *
 * **Sessions are stored hashed.** A session is a bearer credential: whoever holds the cookie value is the
 * user. The store therefore only ever sees the SHA-256 of it, so a read of the database (a backup, a
 * mis-scoped query, a log) yields nothing that can be replayed. The port takes the hash, never the token,
 * so an adapter cannot store the wrong thing by accident.
 *
 * This is a **system-actor** port, like the job runner's half of `JobStore`: a session is looked up by its
 * hash *before* anyone knows whose request it is, so nothing here can be owner-scoped. Under Postgres the
 * three tables admit only the system actor (`postgres-schema.ts`), and no request path holds an
 * `AuthStore` — only the auth routes and the authenticator built from it do (`auth/hosted.ts`).
 */

export type UserId = string;

export interface User {
  id: UserId;
  /** The provider's display handle at the last sign-in. For display only — never an identifier. */
  login: string;
  name: string | null;
  /** ISO-8601, UTC. */
  createdAt: string;
}

/** What a provider told us about a person who just proved who they are. */
export interface ProviderProfile {
  provider: string;
  /** The provider's stable id for the person (GitHub's numeric id as a string), not a handle. */
  subject: string;
  login: string;
  name: string | null;
}

export interface Session {
  userId: UserId;
  /** ISO-8601, UTC. */
  expiresAt: string;
}

export interface AuthStore {
  /**
   * The user this identity belongs to, created on first sight. Idempotent and race-safe: two first
   * sign-ins of one person at once yield one user. The display fields are refreshed on every call, since
   * they are the provider's to change.
   */
  signIn(profile: ProviderProfile): Promise<User>;
  getUser(id: UserId): Promise<User | null>;
  /** Record a session by the SHA-256 (hex) of its token. The token itself never reaches the store. */
  createSession(tokenHash: string, userId: UserId, expiresAt: string): Promise<void>;
  /** The session for this hash, or `null` if there is none **or it has expired as of `now`** (ISO-8601). */
  findSession(tokenHash: string, now: string): Promise<Session | null>;
  /** End a session. `false` when there was none, which signing out twice must not make an error. */
  deleteSession(tokenHash: string): Promise<boolean>;
  /** Drop every session expired as of `now`. Returns how many. Housekeeping; `findSession` never relies on it. */
  purgeExpiredSessions(now: string): Promise<number>;
  close(): Promise<void>;
}
