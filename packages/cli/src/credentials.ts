import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where the CLI keeps the API token it was given (V21, ADR-0034 decision 4).
 *
 * One JSON file, **keyed by server URL**, so signing in to a hosted deployment does not touch the
 * credential for another and — the property that matters — a token is only ever sent to the server it
 * was issued by. A client that attached "the" token to whatever `--url` said would hand a credential to
 * any server a typo or a malicious script pointed it at.
 *
 *   ${XDG_CONFIG_HOME:-~/.config}/sbscore/credentials.json     mode 0600, directory 0700
 *
 * **The file is never wider than 0600, not even briefly.** It is written to a temporary file created
 * with mode 0600 and renamed into place, so there is no window in which a token sits in a file other
 * users can read, and a crash mid-write leaves the old file whole rather than half a new one.
 * `SBSCORE_CREDENTIALS` names a different file; `SBSCORE_TOKEN` stands in for the file entirely (see
 * `resolveToken`), which is how a CI job holds a credential without a home directory.
 */

export interface Credential {
  token: string;
  tokenId?: string;
  scopes?: readonly string[];
  /** ISO-8601, UTC. What the server said at the time; for display, never for deciding anything. */
  expiresAt?: string;
  savedAt: string;
}

type Store = Record<string, Credential>;

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SBSCORE_CREDENTIALS !== undefined && env.SBSCORE_CREDENTIALS !== '') return env.SBSCORE_CREDENTIALS;
  const config = env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  return join(config, 'sbscore', 'credentials.json');
}

/** The key a server is filed under: scheme, host, port and path, with no trailing slash. */
export function serverKey(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return baseUrl.replace(/\/+$/, '');
  }
}

function readStore(path: string): Store {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    // A file that is not JSON is not a credential. Reading it as empty means the next login replaces it,
    // which is the recovery a person would want; it is never silently merged with.
    return {};
  }
}

export function loadCredential(path: string, baseUrl: string): Credential | undefined {
  const found = readStore(path)[serverKey(baseUrl)];
  return found !== undefined && typeof found.token === 'string' && found.token !== '' ? found : undefined;
}

/** `true` when group or others can read the file: a bearer token should not be. */
export function isReadableByOthers(path: string): boolean {
  try {
    return (statSync(path).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

function writeStore(path: string, store: Store): void {
  const directory = dirname(path);
  // 0700 on the directory we create. A parent that already exists (like ~/.config) is not ours to change.
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (basenameIsOurs(directory)) chmodSync(directory, 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  // `mode` is filtered by the umask on creation and ignored if the file already existed; say it outright.
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/** Only the `sbscore` directory this module made is tightened, never a shared one like `~/.config`. */
function basenameIsOurs(directory: string): boolean {
  return directory.split(/[\\/]/).at(-1) === 'sbscore';
}

export function saveCredential(path: string, baseUrl: string, credential: Credential): void {
  const store = readStore(path);
  store[serverKey(baseUrl)] = credential;
  writeStore(path, store);
}

/** Forget the credential for one server. `false` when there was none. Other servers' credentials stay. */
export function removeCredential(path: string, baseUrl: string): boolean {
  const store = readStore(path);
  const key = serverKey(baseUrl);
  if (store[key] === undefined) return false;
  delete store[key];
  writeStore(path, store);
  return true;
}

export type TokenSource = 'SBSCORE_TOKEN' | 'file';

/**
 * The token to present to this server, and where it came from. The environment wins over the file, so a
 * script can override a person's stored credential without editing it.
 */
export function resolveToken(
  path: string,
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): { token: string; source: TokenSource; credential?: Credential } | undefined {
  const fromEnv = env.SBSCORE_TOKEN?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return { token: fromEnv, source: 'SBSCORE_TOKEN' };
  const credential = loadCredential(path, baseUrl);
  return credential === undefined ? undefined : { token: credential.token, source: 'file', credential };
}
