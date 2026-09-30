import { afterEach, describe, expect, it } from 'vitest';
import { describeDatabase, parseFlags, redactCredentials, resolveDatabaseUrl } from '@sibei/cli';

/**
 * Choosing Postgres for `sbscore serve` (V19, ADR-0034) — the parts that need no database: what is
 * printed, and which environment variable can turn it on. The real run against a server is
 * `tests/postgres/serve.test.ts`.
 */

const saved = { url: process.env.SBSCORE_DATABASE_URL, generic: process.env.DATABASE_URL };

afterEach(() => {
  for (const [key, value] of [
    ['SBSCORE_DATABASE_URL', saved.url],
    ['DATABASE_URL', saved.generic],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('what serve prints about the database', () => {
  it('names the scheme, host, port and database — never the user or the password', () => {
    const shown = describeDatabase('postgres://sibei_app:hunter2@db.internal:5432/sibei?sslmode=require');
    expect(shown).toBe('postgres://db.internal:5432/sibei');
    expect(shown).not.toMatch(/hunter2|sibei_app@|sslmode/);
  });

  it('survives an encoded password and an unparseable URL without echoing either', () => {
    expect(describeDatabase('postgres://u:p%40ss%2Fword@h/db')).toBe('postgres://h/db');
    const broken = describeDatabase('not a url with secret-token in it');
    expect(broken).not.toMatch(/secret-token/);
  });
});

describe('what serve says when the database cannot be opened', () => {
  const url = 'postgres://sibei_app:s3cret-pw@db.internal:5432/sibei';

  it('strips the URL and the password from a message that quotes them, but keeps the username', () => {
    const message = `connect failed for ${url}: password authentication failed for user "sibei_app" (s3cret-pw)`;
    const shown = redactCredentials(message, url);
    expect(shown).not.toMatch(/s3cret-pw/);
    expect(shown).toContain('postgres://db.internal:5432/sibei');
    // The username is a diagnostic, not a secret: `role "sibei_app" is a superuser` must stay readable.
    expect(shown).toContain('sibei_app');
  });

  it('leaves an innocent message alone', () => {
    expect(redactCredentials('permission denied for schema public', url)).toBe('permission denied for schema public');
  });
});

describe('which setting selects Postgres', () => {
  it('is the flag or SBSCORE_DATABASE_URL, the flag winning', () => {
    process.env.SBSCORE_DATABASE_URL = 'postgres://env/db';
    expect(resolveDatabaseUrl(parseFlags(['--database-url', 'postgres://flag/db']))).toBe('postgres://flag/db');
    expect(resolveDatabaseUrl(parseFlags([]))).toBe('postgres://env/db');
  });

  it('is off by default, and an empty value is off, not a broken URL', () => {
    delete process.env.SBSCORE_DATABASE_URL;
    expect(resolveDatabaseUrl(parseFlags([]))).toBeUndefined();
    process.env.SBSCORE_DATABASE_URL = '';
    expect(resolveDatabaseUrl(parseFlags([]))).toBeUndefined();
  });

  it('is never the generic DATABASE_URL, which an unrelated environment may have set', () => {
    // An ambient DATABASE_URL (another project's shell, a PaaS, a CI runner) must not be able to move a
    // local user's library to a database they never chose.
    delete process.env.SBSCORE_DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://somebody-elses/database';
    expect(resolveDatabaseUrl(parseFlags([]))).toBeUndefined();
  });
});
