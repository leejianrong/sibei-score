import { afterEach, describe, expect, it } from 'vitest';
import { CliError, parseFlags, resolveHostedConfig } from '@sibei/cli';

/**
 * Hosted mode is chosen by configuration and only by configuration (V20, ADR-0034): all three settings
 * present, or none. None is the local app, unchanged; a partial set is refused at boot rather than
 * discovered by the first person who tries to sign in.
 */

const KEYS = ['SBSCORE_PUBLIC_URL', 'SBSCORE_GITHUB_CLIENT_ID', 'SBSCORE_GITHUB_CLIENT_SECRET'] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function clean(): void {
  for (const key of KEYS) delete process.env[key];
}

describe('resolveHostedConfig', () => {
  it('is undefined with nothing set — local mode needs no configuration at all', () => {
    clean();
    expect(resolveHostedConfig(parseFlags(['serve']))).toBeUndefined();
  });

  it('reads all three, the secret from the environment only', () => {
    clean();
    process.env.SBSCORE_GITHUB_CLIENT_SECRET = 's3cret';
    const config = resolveHostedConfig(
      parseFlags(['serve', '--public-url', 'https://sibei.example', '--github-client-id', 'id123']),
    );
    expect(config).toEqual({ publicUrl: 'https://sibei.example', clientId: 'id123', clientSecret: 's3cret' });
  });

  it('refuses a partial configuration, naming what is missing and never a value', () => {
    clean();
    process.env.SBSCORE_GITHUB_CLIENT_SECRET = 'do-not-print-me';
    try {
      resolveHostedConfig(parseFlags(['serve', '--github-client-id', 'id123']));
      expect.unreachable('a partial configuration must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      const text = (error as Error).message;
      expect(text).toContain('--public-url');
      expect(text).not.toContain('do-not-print-me');
      expect(text).not.toContain('id123');
    }
  });

  it('does not take the secret from a flag, which would land in `ps` and shell history', () => {
    clean();
    expect(() =>
      resolveHostedConfig(
        parseFlags(['serve', '--public-url', 'https://x.example', '--github-client-id', 'i', '--github-client-secret', 's']),
      ),
    ).toThrow(/SBSCORE_GITHUB_CLIENT_SECRET/);
  });
});
