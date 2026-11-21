import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { consoleLogger, createApi, createBlobSweeper, createHttpWorkerClient, createLimits, HOSTED_AUDIO_HOLD, parseAudioPlans, parseWorkerCredential, limitsFromEnv, writeCapsFromEnv, memoryRateLimiter, openDirectoryBlobStore, openS3BlobStore } from '@sibei/api';
import type { Api, AssetSource, AudioQuotaConfig, AudioWorkerOptions, S3BlobStoreOptions, WorkerClient } from '@sibei/api';
import { openPostgresAudioJobStore, openPostgresAuthStore, openPostgresBlobLedger, openPostgresJobStore, openPostgresStore } from '@sibei/api/postgres';
import { openSqliteAudioJobStore, openSqliteAuthStore, openSqliteBlobLedger, openSqliteJobStore, openSqliteStore } from '@sibei/api/sqlite';
import type { AudioJobStore, AuthStore, BlobLedger, JobStore, ScoreStore } from '@sibei/api';
import type { Flags } from './args.js';
import { optionalPort } from './args.js';
import { CliError } from './client.js';
import type { Io } from './commands.js';
import { EXIT } from './exit-codes.js';
import type { ExitCode } from './exit-codes.js';
import { loadAssets } from './static-assets.js';

/**
 * `sbscore serve` — the thing that runs the API.
 *
 * SLICES.md's V2 build plan does not list a `serve` verb, and strictly it did not need to: the API is
 * a library and the tests construct it directly. But V2's demo is "author a chart entirely from the
 * CLI", and without this there is nothing for the CLI to talk to, so the slice would not have been
 * demonstrable. Noting it rather than pretending it was in the plan.
 *
 * V8 ships the container that runs this. From V8g it can also serve the built browser UI itself
 * (`--ui`/`SBSCORE_UI`), which is what lets a shipped image answer both the app and its `/v1/` calls
 * on one origin — the arrangement ADR-0029's Origin/Host guards assume. In development this stays
 * off: Vite serves the app and proxies `/v1/` here. From V8h `--host`/`SBSCORE_HOST` (default
 * `127.0.0.1`) chooses the bind address so the container can bind `0.0.0.0` (ADR-0029 amendment);
 * the compose file keeps the LAN out by publishing only to the host's loopback.
 */

export const DEFAULT_PORT = 4321;

/** The directory the library lives in, under the XDG data home. Named after the binary. */
const DATA_DIRECTORY = 'sbscore';

/**
 * What that directory was called until the binary was renamed `sibei` -> `sbscore` (KAN-599,
 * 2026-08-01). It exists here for one reason — `adoptLegacyDataDirectory` below — and for nothing
 * else. Nothing reads or writes through it.
 */
const LEGACY_DATA_DIRECTORY = 'sibei';

/** `$XDG_DATA_HOME`, or the spec's fallback. One place, because the adoption has to look in it too. */
function dataHome(): string {
  const xdg = process.env.XDG_DATA_HOME;
  return xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.local', 'share');
}

/** Where the library lives. XDG-ish, and overridable, because a test wants a throwaway one. */
export function defaultDataPath(): string {
  return join(dataHome(), DATA_DIRECTORY, 'scores.db');
}

/**
 * What the adoption did. A value rather than a log line, so `serve` owns the prose and a test owns
 * the outcome — the same split `formatAddressFailure` exists for.
 */
export type DataDirectoryAdoption =
  | { kind: 'adopted'; from: string; to: string }
  | { kind: 'both-exist'; legacy: string; current: string }
  | { kind: 'nothing-to-do' };

/**
 * Move a pre-rename library into place, once.
 *
 * **Renaming the default directory without this orphans a live library silently** — the new path
 * does not exist, so a fresh empty database appears beside a full one and nothing says so. ADR-0028
 * calls the data in this store irreplaceable, and its whole argument is that quietly misreading an
 * old document is the worst available outcome; quietly failing to *find* it is the same failure one
 * step earlier. It does not fail, it lies.
 *
 * A one-time move, chosen over the two alternatives:
 *
 * - **Read through to the old path** would leave the directory name a function of which library
 *   happened to exist first, forever, and every later feature would have to keep asking. Q81's
 *   export cache already keys on paths this decides.
 * - **A hard error telling the operator to move it** is honest but it makes an upgrade a manual
 *   step for a rename nobody outside this repo asked for.
 *
 * A move is forward-only and deterministic — the same shape as ADR-0028's migrate-on-read, and for
 * the same reason: there is exactly one live location afterwards.
 *
 * **It moves the whole directory, in one `rename`, which takes `blobs/` with it.** That is not
 * because the export cache is precious — Q81 invalidates implicitly through the key and every blob
 * is regenerable, so dropping it would have been defensible. It is because a directory rename
 * within one parent is atomic and cannot half-complete, where moving `scores.db` and then `blobs/`
 * can. It also carries SQLite's `-wal` and `-shm` sidecars, which a file-by-file move would have
 * had to know about (the store runs in WAL mode) and which hold committed data.
 *
 * Idempotent: after the move the old path is gone, so the first branch takes it from then on. And
 * it never overwrites — an existing new-path library stops the move dead.
 */
export function adoptLegacyDataDirectory(): DataDirectoryAdoption {
  const home = dataHome();
  const legacy = join(home, LEGACY_DATA_DIRECTORY);
  const current = join(home, DATA_DIRECTORY);

  // A plain file at either name is nobody's library. Treated as absent rather than moved, so a
  // stray `~/.local/share/sibei` file cannot become a directory this code then tries to open.
  if (!isDirectory(legacy)) return { kind: 'nothing-to-do' };
  if (isDirectory(current)) return { kind: 'both-exist', legacy, current };

  try {
    renameSync(legacy, current);
  } catch (error) {
    // Falling through to a fresh database here is the exact failure this function exists to
    // prevent, so it refuses to start instead and says what to do by hand.
    throw new CliError(
      EXIT.usage,
      'legacy-data-directory',
      `found a library at ${legacy} from before the CLI was renamed, and could not move it to ` +
        `${current}. Move it yourself, or point --data (or SBSCORE_DATA) at it.`,
      { detail: error instanceof Error ? error.message : undefined },
    );
  }
  return { kind: 'adopted', from: legacy, to: current };
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * The only place the adoption's prose lives, and it is deliberately loud.
 *
 * `both-exist` reports on every start rather than once, because there is nowhere to remember
 * "once" that is not itself state to get wrong — and a library sitting unreferenced is worth
 * saying every time until somebody deals with it.
 */
function describeAdoption(adoption: DataDirectoryAdoption): string | undefined {
  switch (adoption.kind) {
    case 'adopted':
      return (
        `moved your library from ${adoption.from} to ${adoption.to}\n` +
        `  (the CLI is \`sbscore\` now, so its data directory is too; charts and cached exports came with it)`
      );
    case 'both-exist':
      return (
        `note: a library from before the rename is still at ${adoption.legacy}, and it is not the one in use.\n` +
        `  Nothing was moved, because ${adoption.current} already exists. If the older one is the one you\n` +
        `  want, stop the server and swap them by hand.`
      );
    case 'nothing-to-do':
      return undefined;
  }
}

/**
 * Where cached exports live: beside the library, because they are *of* the library.
 *
 * `packages/api` takes a port and never a path (ADR-0001, ADR-0006), so naming a directory is the
 * caller's job and this is the caller. Without it `createApi` falls back to a process-lifetime
 * `Map` and every restart re-renders every chart — correct, but a cache that never survives
 * anything is not much of one.
 */
export function defaultBlobPath(databaseFile: string): string {
  return join(dirname(databaseFile), 'blobs');
}

/**
 * The built-UI directory to serve, or `undefined` when none was asked for (the development default,
 * where Vite serves the app). `--ui` or `SBSCORE_UI` names a directory; the container sets it.
 *
 * **A named-but-wrong directory is a hard error, not a silent skip.** An operator who passed `--ui`
 * wants the UI served, so a path that is not a directory, or a directory with no `index.html` in it
 * (an unbuilt or half-copied bundle), stops the server rather than starting one that answers `/`
 * with a 404 and looks broken for a reason nothing explains — the same stance `--data` takes.
 */
/**
 * The address to bind, or `undefined` to let the API keep its loopback default (ADR-0029). `--host`
 * or `SBSCORE_HOST` overrides it; the container sets `0.0.0.0`.
 *
 * **This is the one knob ADR-0029's amendment (V8h) opened, and it opens deliberately.** A container
 * has to bind `0.0.0.0` so Docker's published port (forwarded to the bridge interface) can reach the
 * process; the LAN-unreachability ADR-0029 wants then lives on the *publish* address in the compose
 * file (`127.0.0.1:PORT:PORT`), not on the bind. The default stays `127.0.0.1`, so a bare
 * `sbscore serve` binds loopback exactly as before — nothing widens unless someone asks for it.
 */
export function resolveBindHost(flags: Flags): string | undefined {
  const chosen = flags.options.get('host') ?? process.env.SBSCORE_HOST;
  return chosen === undefined || chosen === '' ? undefined : chosen;
}

/**
 * The OMR worker's base URL, or `undefined` when none was configured — in which case import is off
 * (`POST /v1/imports` is a 503) and every other feature is unaffected (V10, Q80). `--worker` or
 * `SBSCORE_WORKER_URL` names it; the container's compose file sets `http://worker:8000`, the private
 * service address on the compose network (ADR-0005: two containers, the worker isolated). There is
 * no default URL on purpose: a bare `pnpm serve` has no worker running, and pointing at one that is
 * not there would turn every import into a failed job instead of an honest "not configured".
 */
export function resolveWorkerUrl(flags: Flags): string | undefined {
  const chosen = flags.options.get('worker') ?? process.env.SBSCORE_WORKER_URL;
  return chosen === undefined || chosen === '' ? undefined : chosen;
}

/**
 * Whether photo import is offered (SIB2-201): `SBSCORE_PHOTO_IMPORT=on|off`. Default off in hosted mode
 * (photo import is not part of the launch, ADR-0039, and the hosted worker has no bespoke weights) and on
 * everywhere else, so a local install is exactly what it was.
 */
export function resolvePhotoImport(hosted: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const chosen = (env.SBSCORE_PHOTO_IMPORT ?? '').toLowerCase();
  if (chosen !== '' && chosen !== 'on' && chosen !== 'off') {
    throw new CliError(EXIT.usage, 'bad-photo-import-config', 'SBSCORE_PHOTO_IMPORT must be `on` or `off`');
  }
  return chosen === '' ? !hosted : chosen === 'on';
}

/**
 * The redirect hosts the MCP consent page treats as known clients (SIB2-207): `SBSCORE_MCP_KNOWN_HOSTS`,
 * comma-separated hostnames (`*.example.com` for subdomains), or `undefined` for the API's default list.
 */
export function resolveMcpKnownHosts(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = (env.SBSCORE_MCP_KNOWN_HOSTS ?? '').trim();
  if (raw === '') return undefined;
  return raw.split(',').map((h) => h.trim().toLowerCase()).filter((h) => h !== '');
}

export function resolveUiDirectory(flags: Flags): string | undefined {
  const chosen = flags.options.get('ui') ?? process.env.SBSCORE_UI;
  if (chosen === undefined || chosen === '') return undefined;

  const directory = resolve(chosen);
  if (!isDirectory(directory)) {
    throw new CliError(
      EXIT.usage,
      'no-ui-directory',
      `--ui (or SBSCORE_UI) points at ${directory}, which is not a directory. Build the browser ` +
        `with \`pnpm --filter @sibei/ui build\` and point it at the \`dist\` that produces.`,
    );
  }
  if (!existsSync(join(directory, 'index.html'))) {
    throw new CliError(
      EXIT.usage,
      'no-ui-index',
      `--ui (or SBSCORE_UI) points at ${directory}, which has no index.html — that is not a built ` +
        `UI bundle. Point it at the \`dist\` from \`pnpm --filter @sibei/ui build\`.`,
    );
  }
  return directory;
}

/**
 * The Postgres database to serve from, or `undefined` for the local SQLite library (V19, ADR-0034).
 * `--database-url` or `SBSCORE_DATABASE_URL` names it.
 *
 * **Deliberately not the generic `DATABASE_URL`.** That variable is set in plenty of unrelated
 * environments (another project's shell, a PaaS, a CI runner), and reading it here would let an ambient
 * value silently move a local user's library to a database they never chose. Opting in to a different
 * store has to be something this program was told to do by name. (ADR-0034 said `DATABASE_URL` in
 * passing; this is the deliberate refinement of it.)
 */
export function resolveDatabaseUrl(flags: Flags): string | undefined {
  const chosen = flags.options.get('database-url') ?? process.env.SBSCORE_DATABASE_URL;
  return chosen === undefined || chosen === '' ? undefined : chosen;
}

/**
 * A database URL fit to print: scheme, host, port and database name — never the user or the password.
 * `serve` tells the operator where their charts are, and that line ends up in terminals, container logs
 * and screenshots, none of which may carry a credential (ADR-0029).
 */
export function describeDatabase(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return 'postgres (the URL could not be parsed, so it is not shown)';
  }
}

/** A positive whole number from the environment, or `fallback`; a malformed one is a usage error naming it. */
function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new CliError(EXIT.usage, 'bad-sweep-config', `${name} must be a positive whole number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * GitHub's endpoints, overridable for the compose smoke test only (V24): `SBSCORE_GITHUB_BASE_URL` points
 * the whole code flow at a fake GitHub (`scripts/fake-github.ts`). It is operator configuration like every
 * other variable here, and unset (the only production setting) means github.com. `serve` says so loudly when
 * it is set, because sign-in against anything but GitHub is never what a real deployment wants.
 */
function githubEndpoints(): { authorizeUrl: string; tokenUrl: string; userUrl: string } | Record<string, never> {
  const base = process.env.SBSCORE_GITHUB_BASE_URL;
  if (base === undefined || base === '') return {};
  const root = base.replace(/\/+$/, '');
  console.error(`sbscore: GitHub sign-in is pointed at ${root}, not github.com (SBSCORE_GITHUB_BASE_URL). Test use only.`);
  return {
    authorizeUrl: `${root}/login/oauth/authorize`,
    tokenUrl: `${root}/login/oauth/access_token`,
    userUrl: `${root}/user`,
  };
}

/** What hosted mode needs to sign anybody in (V20, ADR-0034). */
export interface HostedConfig {
  publicUrl: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Hosted mode, or `undefined` for the local default — which is **no configuration at all**: with none of
 * these set, `serve` is exactly what it was before V20 (the local principal, no sign-in).
 *
 *   --public-url / SBSCORE_PUBLIC_URL           where browsers reach this deployment (https)
 *   --github-client-id / SBSCORE_GITHUB_CLIENT_ID
 *   SBSCORE_GITHUB_CLIENT_SECRET                 **environment only**, deliberately: a flag lands in `ps`,
 *                                                shell history and a container's inspect output
 *
 * All or nothing. A deployment with the id but no secret would otherwise start, serve nobody, and fail
 * only when the first person tried to sign in — so a partial configuration is refused at boot, naming
 * what is missing (never a value).
 */
export function resolveHostedConfig(flags: Flags): HostedConfig | undefined {
  const given = (value: string | undefined): string | undefined => (value === undefined || value === '' ? undefined : value);
  const publicUrl = given(flags.options.get('public-url') ?? process.env.SBSCORE_PUBLIC_URL);
  const clientId = given(flags.options.get('github-client-id') ?? process.env.SBSCORE_GITHUB_CLIENT_ID);
  const clientSecret = given(process.env.SBSCORE_GITHUB_CLIENT_SECRET);
  if (publicUrl === undefined && clientId === undefined && clientSecret === undefined) return undefined;

  const missing = [
    publicUrl === undefined ? '--public-url (or SBSCORE_PUBLIC_URL)' : undefined,
    clientId === undefined ? '--github-client-id (or SBSCORE_GITHUB_CLIENT_ID)' : undefined,
    clientSecret === undefined ? 'SBSCORE_GITHUB_CLIENT_SECRET' : undefined,
  ].filter((name) => name !== undefined);
  if (publicUrl === undefined || clientId === undefined || clientSecret === undefined) {
    throw new CliError(
      EXIT.usage,
      'incomplete-hosted-config',
      `hosted mode (GitHub sign-in) needs all of its settings, and these are missing: ${missing.join(', ')}. ` +
        `Set none of them to run the local app.`,
    );
  }
  return { publicUrl, clientId, clientSecret };
}

/** Where the exported-PDF cache and the uploaded scans live: `--blobs`/`SBSCORE_BLOBS`, else beside the library. */
function resolveBlobDirectory(flags: Flags, libraryFile: string): string {
  const chosen = flags.options.get('blobs') ?? process.env.SBSCORE_BLOBS;
  return chosen === undefined || chosen === '' ? defaultBlobPath(libraryFile) : resolve(chosen);
}

/**
 * Object storage for blobs (SIB2-136): `SBSCORE_S3_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY_ID` and
 * `SBSCORE_S3_SECRET_ACCESS_KEY` all together, or none. Environment only — a secret does not belong in
 * argv — and, like the Postgres URL, a *named* variable so an ambient AWS_* in an unrelated shell cannot
 * silently move a local install's blobs. Without them the blobs live on disk, exactly as before.
 */
export function resolveS3Config(env: NodeJS.ProcessEnv = process.env): S3BlobStoreOptions | undefined {
  const get = (name: string): string | undefined => {
    const value = env[`SBSCORE_S3_${name}`];
    return value === undefined || value === '' ? undefined : value;
  };
  const endpoint = get('ENDPOINT');
  const bucket = get('BUCKET');
  const accessKeyId = get('ACCESS_KEY_ID');
  const secretAccessKey = get('SECRET_ACCESS_KEY');
  const set = [endpoint, bucket, accessKeyId, secretAccessKey].filter((value) => value !== undefined).length;
  if (set === 0) return undefined;
  if (endpoint === undefined || bucket === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
    throw new CliError(
      EXIT.usage,
      'bad-s3-config',
      'object storage needs SBSCORE_S3_ENDPOINT, SBSCORE_S3_BUCKET, SBSCORE_S3_ACCESS_KEY_ID and SBSCORE_S3_SECRET_ACCESS_KEY together',
    );
  }
  const publicEndpoint = get('PUBLIC_ENDPOINT');
  const prefix = get('PREFIX');
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: get('REGION') ?? 'us-east-1',
    ...(publicEndpoint === undefined ? {} : { publicEndpoint }),
    ...(prefix === undefined ? {} : { prefix }),
  };
}

/**
 * The audio worker's credentials (SIB2-138): `SBSCORE_AUDIO_WORKER_TOKENS`, comma-separated, each
 * `sbsw_` followed by at least 32 characters, or `name=sbsw_…` to name it (SEC M2); remove an entry to revoke it. Environment only — a credential does not belong in argv. With
 * none set there is no `/v1/worker/` surface and audio jobs wait `queued`. Lease timing is tunable
 * (`SBSCORE_AUDIO_LEASE_SECONDS`, `SBSCORE_AUDIO_MAX_ATTEMPTS`) and defaults to the protocol's 120 s and 3.
 */
export function resolveAudioWorker(env: NodeJS.ProcessEnv = process.env): AudioWorkerOptions | undefined {
  const raw = (env.SBSCORE_AUDIO_WORKER_TOKENS ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '');
  if (raw.length === 0) return undefined;
  const names = new Set<string>();
  for (const entry of raw) {
    const { name, token } = parseWorkerCredential(entry);
    if (!/^sbsw_[A-Za-z0-9_-]{32,}$/.test(token) || (entry.includes('=') && !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) || names.has(name)) {
      throw new CliError(
        EXIT.usage,
        'bad-audio-worker-config',
        'every SBSCORE_AUDIO_WORKER_TOKENS entry must be `sbsw_` followed by at least 32 letters, digits, `_` or `-`, optionally as `name=sbsw_…` with a distinct lowercase name (try `sbsw_$(openssl rand -hex 24)`)',
      );
    }
    names.add(name);
  }
  const number = (name: string): number | undefined => {
    const value = env[name];
    if (value === undefined || value === '') return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new CliError(EXIT.usage, 'bad-audio-worker-config', `${name} must be a whole number of at least 1`);
    }
    return parsed;
  };
  const leaseSeconds = number('SBSCORE_AUDIO_LEASE_SECONDS');
  const maxAttempts = number('SBSCORE_AUDIO_MAX_ATTEMPTS');
  return {
    tokens: raw,
    ...(leaseSeconds === undefined ? {} : { leaseSeconds }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  };
}

/**
 * Per-user audio jobs in flight and the bytes they hold (SEC H4): `SBSCORE_AUDIO_MAX_INFLIGHT` and
 * `SBSCORE_AUDIO_MAX_INFLIGHT_MB`. On by default in hosted mode (3 jobs, 300 MB: audio sits on the same disk
 * as the database); off for a local install unless a variable is set.
 */
export function resolveAudioHold(env: NodeJS.ProcessEnv, hosted: boolean): { maxInFlightJobs: number; maxInFlightBytes: number } | undefined {
  const read = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new CliError(EXIT.usage, 'bad-audio-quota-config', `${name} must be a whole number of at least 1`);
    return value;
  };
  const jobs = read('SBSCORE_AUDIO_MAX_INFLIGHT');
  const megabytes = read('SBSCORE_AUDIO_MAX_INFLIGHT_MB');
  if (!hosted && jobs === undefined && megabytes === undefined) return undefined;
  return {
    maxInFlightJobs: jobs ?? HOSTED_AUDIO_HOLD.maxInFlightJobs,
    maxInFlightBytes: megabytes === undefined ? HOSTED_AUDIO_HOLD.maxInFlightBytes : megabytes * 1024 * 1024,
  };
}

/**
 * The audio-second allowance (SIB2-140): `SBSCORE_AUDIO_FREE_SECONDS`, what every user gets per month, and
 * `SBSCORE_AUDIO_PLANS`, per-user overrides (`usr_abc=unlimited,usr_def=7200`). Unset means no cap, the
 * local default. Configuration, so changing a limit is an environment edit and a restart, not a release.
 */
export function resolveAudioQuota(env: NodeJS.ProcessEnv = process.env): AudioQuotaConfig | undefined {
  const free = env.SBSCORE_AUDIO_FREE_SECONDS;
  const plansText = env.SBSCORE_AUDIO_PLANS;
  if ((free === undefined || free === '') && (plansText === undefined || plansText === '')) return undefined;
  let freeSeconds: number | null = null;
  if (free !== undefined && free !== '') {
    freeSeconds = Number(free);
    if (!Number.isInteger(freeSeconds) || freeSeconds < 0) {
      throw new CliError(EXIT.usage, 'bad-audio-quota-config', 'SBSCORE_AUDIO_FREE_SECONDS must be a whole number of seconds (0 or more)');
    }
  }
  try {
    return { freeSeconds, plans: parseAudioPlans(plansText ?? '') };
  } catch (error) {
    throw new CliError(EXIT.usage, 'bad-audio-quota-config', `SBSCORE_AUDIO_PLANS: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The two stores, and how to release them, whichever database they sit on. */
interface OpenedStores {
  store: ScoreStore;
  jobStore: JobStore;
  /** Which account owns which blob (V25). */
  blobLedger: BlobLedger;
  /** Audio jobs (SIB2-137), the second kind of durable job. */
  audioJobStore: AudioJobStore;
  /** Only opened in hosted mode (V20); local mode has no users. */
  authStore?: AuthStore;
}

/**
 * Open the score store and the job store on the chosen database. SQLite shares one file between two
 * connections (ADR-0006); Postgres gives each its own pool, and both refuse to run as a role that row-level
 * security does not bind unless told to (`--allow-rls-bypass`, for local development only).
 */
async function openStores(
  databaseUrl: string | undefined,
  filename: string,
  flags: Flags,
  hosted: boolean,
): Promise<OpenedStores> {
  if (databaseUrl === undefined) {
    return {
      store: openSqliteStore({ filename }),
      jobStore: openSqliteJobStore({ filename }),
      blobLedger: openSqliteBlobLedger({ filename }),
      audioJobStore: openSqliteAudioJobStore({ filename }),
      ...(hosted ? { authStore: openSqliteAuthStore({ filename }) } : {}),
    };
  }
  const allowRlsBypass = flags.switches.has('allow-rls-bypass') || process.env.SBSCORE_ALLOW_RLS_BYPASS === '1';
  try {
    const store = await openPostgresStore({ connectionString: databaseUrl, allowRlsBypass });
    const jobStore = await openPostgresJobStore({ connectionString: databaseUrl, allowRlsBypass });
    const audioJobStore = await openPostgresAudioJobStore({ connectionString: databaseUrl, allowRlsBypass });
    const blobLedger = await openPostgresBlobLedger({ connectionString: databaseUrl, allowRlsBypass });
    const authStore = hosted ? await openPostgresAuthStore({ connectionString: databaseUrl, allowRlsBypass }) : undefined;
    return { store, jobStore, audioJobStore, blobLedger, ...(authStore === undefined ? {} : { authStore }) };
  } catch (error) {
    // Never echo the error's own text wholesale: a connection failure can carry the URL, and with it the
    // password. The operator gets the cause in words and where it was aimed, redacted.
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(
      EXIT.usage,
      'database-unavailable',
      `could not open the Postgres database at ${describeDatabase(databaseUrl)}: ${redactCredentials(reason, databaseUrl)}`,
    );
  }
}

/**
 * Remove the URL's credentials from a message before it is shown. Belt and braces: `pg` errors do not
 * normally quote the connection string, but a proxy, a wrapper or a future driver might, and a password in
 * a terminal or a container log is not recoverable.
 */
export function redactCredentials(message: string, url: string): string {
  let out = message.split(url).join(describeDatabase(url));
  try {
    // The password only. A username is not a secret and is often the whole diagnostic ("role "postgres"
    // is a superuser"), so masking it would make the message worse without making anything safer.
    const password = decodeURIComponent(new URL(url).password);
    if (password !== '') out = out.split(password).join('***');
  } catch {
    /* an unparseable URL has nothing to pick out */
  }
  return out;
}

export async function serve(flags: Flags, io: Io, json: boolean): Promise<ExitCode> {
  const port = optionalPort(flags, 'port') ?? DEFAULT_PORT;

  const databaseUrl = resolveDatabaseUrl(flags);
  if (databaseUrl !== undefined && flags.options.get('data') !== undefined) {
    // An explicit --data names a SQLite file. Combined with a Postgres URL there is no sensible reading,
    // so refuse rather than guess which the operator meant. (The *environment* variable SBSCORE_DATA is
    // different: the container image sets it by default, so under a database URL it is ignored as a store
    // path and only supplies the default blob directory below.)
    throw new CliError(
      EXIT.usage,
      'conflicting-stores',
      '--data names a SQLite file and cannot be combined with --database-url (or SBSCORE_DATABASE_URL), ' +
        'which selects Postgres. Pass one or the other.',
    );
  }

  // Only the *default* location may be adopted. `--data` and `SBSCORE_DATA` name a path on purpose,
  // and a program that went moving directories around because of a path it was handed would be
  // doing something nobody asked for — including every test in the suite, which passes one.
  const chosen = flags.options.get('data') ?? process.env.SBSCORE_DATA;
  const adoption: DataDirectoryAdoption =
    chosen === undefined && databaseUrl === undefined ? adoptLegacyDataDirectory() : { kind: 'nothing-to-do' };

  const filename = resolve(chosen ?? defaultDataPath());
  const blobDirectory = resolveBlobDirectory(flags, filename);
  // A SQLite library needs its directory to exist before it can be opened; a Postgres one lives elsewhere
  // and only the blobs need a home.
  mkdirSync(databaseUrl === undefined ? dirname(filename) : blobDirectory, { recursive: true });

  // Resolved before opening the store, so a bad --ui fails fast rather than after binding a port.
  const uiDirectory = resolveUiDirectory(flags);
  const assets: AssetSource | undefined =
    uiDirectory === undefined ? undefined : loadAssets(uiDirectory);

  const bindHost = resolveBindHost(flags);
  // What to print. The default binds loopback and reads as `127.0.0.1`; a container binds `0.0.0.0`
  // and the honest line names that address — the operator reaches it through the published mapping.
  const shownHost = bindHost ?? '127.0.0.1';

  // The OMR worker (V10). A URL, resolved here in the composition root; the API package names no
  // address (ADR-0001) — it takes the client as a port. Absent means import is unavailable and every
  // other feature works (Q80). The job store shares the library's database file (one volume), behind
  // its own connection (ADR-0006).
  const hostedConfig = resolveHostedConfig(flags);
  const photoImport = resolvePhotoImport(hostedConfig !== undefined);
  const mcpKnownHosts = resolveMcpKnownHosts();
  // Photo import off (SIB2-201) means no OMR worker is wired even if a URL is set: nothing may call it.
  const workerUrl = photoImport ? resolveWorkerUrl(flags) : undefined;
  const worker: WorkerClient | undefined =
    workerUrl === undefined ? undefined : createHttpWorkerClient({ url: workerUrl });
  const s3Config = resolveS3Config();
  const audioWorker = resolveAudioWorker();
  const audioQuota = resolveAudioQuota();
  const audioHold = resolveAudioHold(process.env, hostedConfig !== undefined);

  // Rate limits and quotas (V23): on in hosted mode, off for a local install (one user on loopback has
  // nobody to be limited against), and overridable either way with SBSCORE_LIMITS=on|off.
  const limitsSwitch = (process.env.SBSCORE_LIMITS ?? '').toLowerCase();
  if (limitsSwitch !== '' && limitsSwitch !== 'on' && limitsSwitch !== 'off') {
    throw new CliError(EXIT.usage, 'bad-limits-config', 'SBSCORE_LIMITS must be `on` or `off`');
  }
  const limitsOn = limitsSwitch === 'on' || (limitsSwitch === '' && hostedConfig !== undefined);
  let limitsConfig: ReturnType<typeof limitsFromEnv> | undefined;
  try {
    limitsConfig = limitsOn ? limitsFromEnv(process.env) : undefined;
  } catch (error) {
    throw new CliError(EXIT.usage, 'bad-limits-config', error instanceof Error ? error.message : String(error));
  }
  const allowedHosts = (flags.options.get('allowed-hosts') ?? process.env.SBSCORE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host !== '');

  // Redis (V23): the cross-process change/job buses and shared rate-limit counters. Absent means the
  // in-process ones — the local case, and a single replica.
  const redisUrl = [flags.options.get('redis-url'), process.env.SBSCORE_REDIS_URL].find((v) => v !== undefined && v !== '');
  let redis: Awaited<ReturnType<(typeof import('@sibei/api/redis'))['openRedis']>> | undefined;
  if (redisUrl !== undefined) {
    const { openRedis } = await import('@sibei/api/redis');
    try {
      redis = await openRedis({ url: redisUrl, onError: (message, error) => consoleLogger.error(message, error) });
    } catch (error) {
      // The URL can carry a password; say where it was aimed, redacted, and not what the driver quoted.
      throw new CliError(
        EXIT.usage,
        'redis-unavailable',
        `${(error instanceof Error ? error.message : String(error)).split(redisUrl).join('redis (url hidden)')}`,
      );
    }
  }
  let writeCaps: ReturnType<typeof writeCapsFromEnv>;
  try {
    writeCaps = writeCapsFromEnv(process.env);
  } catch (error) {
    throw new CliError(EXIT.usage, 'bad-limits-config', error instanceof Error ? error.message : String(error));
  }
  const limits =
    limitsConfig === undefined
      ? undefined
      : createLimits({
          config: limitsConfig,
          limiter: redis?.limiter ?? memoryRateLimiter(),
          onError: (message, error) => consoleLogger.error(message, error),
        });

  const blobs = s3Config === undefined ? openDirectoryBlobStore({ directory: blobDirectory }) : openS3BlobStore(s3Config);
  const { store, jobStore, audioJobStore, blobLedger, authStore } = await openStores(databaseUrl, filename, flags, hostedConfig !== undefined);
  let api: Api;
  try {
    api = createApi({
      ...(limits === undefined ? {} : { limits }),
      writeCaps,
      ...(redis === undefined ? {} : { changeBus: redis.changeBus(), jobBus: redis.jobBus() }),
      ...(allowedHosts.length === 0 ? {} : { allowedHosts }),
      store,
      jobs: jobStore,
      blobLedger,
      audioJobs: audioJobStore,
      ...(audioWorker === undefined ? {} : { audioWorker }),
      ...(audioQuota === undefined ? {} : { audioQuota }),
      ...(audioHold === undefined ? {} : { audioHold }),
      ...(hostedConfig === undefined || authStore === undefined
        ? {}
        : {
            hosted: {
              auth: authStore,
              publicUrl: hostedConfig.publicUrl,
              github: { clientId: hostedConfig.clientId, clientSecret: hostedConfig.clientSecret, ...githubEndpoints() },
            },
          }),
      blobs,
      ...(worker === undefined ? {} : { worker }),
      ...(photoImport ? {} : { photoImport: false }),
      ...(mcpKnownHosts === undefined ? {} : { mcpKnownHosts }),
      ...(assets === undefined ? {} : { assets }),
    });
  } catch (error) {
    // A refused configuration (a plain-http public URL, say) is a usage error, not a crash.
    await Promise.all([jobStore.close(), audioJobStore.close(), store.close(), blobLedger.close(), authStore?.close(), redis?.close()]);
    throw new CliError(EXIT.usage, 'bad-hosted-config', error instanceof Error ? error.message : String(error));
  }
  const bound = await api.listen(port, bindHost);

  // The blob sweep (V25b): expired export-cache and audio objects, found through the ledger. Hosted only: a
  // local install keeps its cache until the person clears it, and has no audio retention promise to keep.
  // Lifetimes are configuration (SBSCORE_SWEEP_EXPORT_DAYS, SBSCORE_SWEEP_AUDIO_HOURS).
  const stopSweep =
    hostedConfig === undefined
      ? undefined
      : createBlobSweeper({
          ledger: blobLedger,
          blobs,
          audioJobs: audioJobStore,
          lifetimes: {
            export: positiveEnv('SBSCORE_SWEEP_EXPORT_DAYS', 1) * 24 * 60 * 60 * 1000,
            audio: positiveEnv('SBSCORE_SWEEP_AUDIO_HOURS', 24) * 60 * 60 * 1000,
          },
          onError: (message, error) => consoleLogger.error(message, error),
        }).start(60 * 60 * 1000);

  // The one place a store path is legitimately printed: the operator asked to start a server and
  // wants to know where their charts are. It never reaches a log line or a response body (ADR-0029).
  //
  // The adoption notice rides in the same output rather than going to stderr, so `serve --json`
  // stays exactly one JSON object and a human sees the line first — a library that just moved is
  // the most important thing on the screen.
  const notice = describeAdoption(adoption);
  io.out(
    json
      ? JSON.stringify({
          listening: `http://${shownHost}:${bound.port}`,
          ...(databaseUrl === undefined ? { data: filename } : { database: describeDatabase(databaseUrl) }),
          blobs: blobDirectory,
          ...(uiDirectory === undefined ? {} : { ui: uiDirectory }),
          ...(workerUrl === undefined ? {} : { worker: workerUrl }),
          ...(hostedConfig === undefined ? {} : { hosted: hostedConfig.publicUrl }),
          ...(redis === undefined ? {} : { redis: true }),
          ...(limits === undefined ? {} : { limits: true }),
          ...(adoption.kind === 'nothing-to-do' ? {} : { dataDirectory: adoption }),
        })
      : (notice === undefined ? '' : `${notice}\n`) +
          `sbscore listening on http://${shownHost}:${bound.port}\n  charts in ${
            databaseUrl === undefined ? filename : describeDatabase(databaseUrl)
          }\n` +
          `  cached exports in ${blobDirectory}\n` +
          (uiDirectory === undefined ? '' : `  serving the UI from ${uiDirectory}\n`) +
          (hostedConfig === undefined ? '' : `  hosted mode: GitHub sign-in required, served as ${hostedConfig.publicUrl}\n`) +
          (redis === undefined ? '' : '  Redis: change streams and rate limits are shared across processes\n') +
          (limits === undefined ? '' : '  rate limits and quotas are on\n') +
          (!photoImport
            ? '  photo import is off (SBSCORE_PHOTO_IMPORT=off): audio and NoteEvents import still work\n'
            : workerUrl === undefined
            ? '  no OMR worker configured — import is unavailable (set --worker or SBSCORE_WORKER_URL)\n'
            : `  OMR worker at ${workerUrl}\n`) +
          `  stop with ctrl-c`,
  );

  const stop = () => {
    // Each close is awaited: the store port is asynchronous (V18), and exiting before a pool has
    // drained would cut off whatever it was still flushing.
    stopSweep?.();
    void api
      .close()
      .then(() => Promise.all([jobStore.close(), audioJobStore.close(), store.close(), blobLedger.close(), authStore?.close(), redis?.close()]))
      .then(() => {
        process.exit(EXIT.ok);
      });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  // Resolve never: the process's job from here is to keep listening.
  return new Promise<ExitCode>(() => {});
}
