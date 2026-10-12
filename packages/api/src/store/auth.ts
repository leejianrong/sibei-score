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

  // --- API tokens and the device flow that mints them (V21a, ADR-0034 decision 4) ---------------------
  //
  // The same shape of port as sessions, for the same reason: a token is a bearer credential looked up by
  // its hash before anyone knows whose request it is, so none of this is owner-scoped and under Postgres
  // the tables admit only the system actor. The one exception to "nothing here takes a user filter" is
  // `revokeToken`, which takes the caller's id so a person can only ever end their own.

  /** Start a device authorisation. `userCode` is the short code a person types; `deviceHash` is the SHA-256 of the secret the CLI holds. */
  createDevice(device: NewDevice): Promise<void>;
  /**
   * Approve the pending authorisation with this user code on behalf of `userId`. `false` when there is no
   * such code, it has expired, or it was already approved: a code approves once.
   */
  approveDevice(userCode: string, approval: DeviceApproval, now: string): Promise<boolean>;
  /**
   * What the CLI's poll gets, and **the only place an approved authorisation is spent**: an approved,
   * unexpired code is deleted in the same step that returns it, so a code can mint one token and never
   * two, however many times and however concurrently it is presented.
   */
  pollDevice(deviceHash: string, now: string, minIntervalMs: number): Promise<DevicePoll>;
  /** Mint a token. Only its hash is stored; the plaintext exists once, in the caller's hands. */
  createToken(token: NewApiToken): Promise<ApiToken>;
  /** The live token for this hash, or `null` if there is none, it was revoked, **or it has expired as of `now`**. */
  findToken(tokenHash: string, now: string): Promise<TokenPrincipal | null>;
  /** This user's tokens, newest first. Never the hash. */
  listTokens(userId: UserId): Promise<ApiToken[]>;
  /** End one of this user's tokens. `false` when they have none by that id (including another user's). */
  revokeToken(userId: UserId, id: string): Promise<boolean>;
  /** Drop expired device authorisations and tokens. Returns how many. Housekeeping; lookups never rely on it. */
  purgeExpiredCredentials(now: string): Promise<number>;
  close(): Promise<void>;
}

/** The scopes a token may carry. Coarse on purpose: V22's MCP audience adds finer ones, and adding is additive. */
export const TOKEN_SCOPES = ['read', 'write'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export interface NewDevice {
  deviceHash: string;
  userCode: string;
  /** ISO-8601, UTC. */
  expiresAt: string;
}

export interface DeviceApproval {
  userId: UserId;
  name: string;
  scopes: readonly TokenScope[];
}

/** A poll's answer. `authorized` carries what to mint and has already spent the authorisation. */
export type DevicePoll =
  | { status: 'pending' }
  | { status: 'slow-down' }
  | { status: 'expired' }
  | { status: 'authorized'; userId: UserId; name: string; scopes: readonly TokenScope[] };

export interface NewApiToken {
  id: string;
  tokenHash: string;
  userId: UserId;
  name: string;
  scopes: readonly TokenScope[];
  /** ISO-8601, UTC. */
  expiresAt: string;
}

/** A token as it is listed: enough to recognise and revoke it, never enough to use it. */
export interface ApiToken {
  id: string;
  name: string;
  scopes: readonly TokenScope[];
  createdAt: string;
  expiresAt: string;
}

/** Who a live token acts as. */
export interface TokenPrincipal {
  id: string;
  userId: UserId;
  scopes: readonly TokenScope[];
}
