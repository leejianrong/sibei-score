import { randomUUID } from 'node:crypto';
import type { AccountStore, ProviderProfile, SessionPolicy, User, UserId } from './accounts.js';
import { isLapsed, sessionDeadlines, slidIdleUntil } from './account-shared.js';
import { timestamp } from './store-shared.js';

/**
 * The account port over `Map`s — the `:memory:` of accounts (cf. `memory-job-store.ts`). What the fast
 * layer runs the OAuth flow and the session authenticator against, and what the conformance suite runs
 * too, so the in-memory double cannot drift from the real adapters. Everything handed out is a copy.
 */
export interface MemoryAccountStoreOptions {
  now?: () => Date;
  newId?: () => UserId;
}

interface SessionRecord {
  userId: UserId;
  expiresAt: string;
  idleUntil: string;
  idleMs: number;
}

export function memoryAccountStore(options: MemoryAccountStoreOptions = {}): AccountStore {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());
  const users = new Map<UserId, User>();
  const identities = new Map<string, UserId>();
  const sessions = new Map<string, SessionRecord>();

  return {
    async signIn(profile: ProviderProfile) {
      const key = `${profile.provider}\u0000${profile.subject}`;
      const existing = identities.get(key);
      const found = existing === undefined ? undefined : users.get(existing);
      if (found !== undefined) {
        const refreshed = { ...found, displayName: profile.displayName, avatarUrl: profile.avatarUrl };
        users.set(found.id, refreshed);
        return { ...refreshed };
      }
      const user: User = {
        id: newId(),
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        createdAt: timestamp(now),
      };
      users.set(user.id, user);
      identities.set(key, user.id);
      return { ...user };
    },

    async getUser(id) {
      const user = users.get(id);
      return user === undefined ? null : { ...user };
    },

    async createSession(userId: UserId, tokenHash: string, policy: SessionPolicy) {
      if (!users.has(userId)) throw new Error(`no such user: ${userId}`);
      const { expiresAt, idleUntil } = sessionDeadlines(now, policy);
      sessions.set(tokenHash, { userId, expiresAt, idleUntil, idleMs: policy.idleMs });
    },

    async resolveSession(tokenHash) {
      const session = sessions.get(tokenHash);
      if (session === undefined) return null;
      if (isLapsed(session.expiresAt, session.idleUntil, timestamp(now))) {
        sessions.delete(tokenHash);
        return null;
      }
      const slid = slidIdleUntil(now, session);
      if (slid !== null) session.idleUntil = slid;
      const user = users.get(session.userId);
      return user === undefined ? null : { ...user };
    },

    async deleteSession(tokenHash) {
      sessions.delete(tokenHash);
    },

    async purgeExpiredSessions() {
      const at = timestamp(now);
      let removed = 0;
      for (const [hash, session] of sessions) {
        if (isLapsed(session.expiresAt, session.idleUntil, at)) {
          sessions.delete(hash);
          removed += 1;
        }
      }
      return removed;
    },

    async close() {},
  };
}
