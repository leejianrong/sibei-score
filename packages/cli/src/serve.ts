import { mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApi, openDirectoryBlobStore } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Flags } from './args.js';
import { optionalPort } from './args.js';
import { CliError } from './client.js';
import type { Io } from './commands.js';
import { EXIT } from './exit-codes.js';
import type { ExitCode } from './exit-codes.js';

/**
 * `sbscore serve` — the thing that runs the API.
 *
 * SLICES.md's V2 build plan does not list a `serve` verb, and strictly it did not need to: the API is
 * a library and the tests construct it directly. But V2's demo is "author a chart entirely from the
 * CLI", and without this there is nothing for the CLI to talk to, so the slice would not have been
 * demonstrable. Noting it rather than pretending it was in the plan.
 *
 * V8 ships the container that runs this; nothing here anticipates that beyond keeping the store path
 * a parameter.
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

export async function serve(flags: Flags, io: Io, json: boolean): Promise<ExitCode> {
  const port = optionalPort(flags, 'port') ?? DEFAULT_PORT;

  // Only the *default* location may be adopted. `--data` and `SBSCORE_DATA` name a path on purpose,
  // and a program that went moving directories around because of a path it was handed would be
  // doing something nobody asked for — including every test in the suite, which passes one.
  const chosen = flags.options.get('data') ?? process.env.SBSCORE_DATA;
  const adoption: DataDirectoryAdoption =
    chosen === undefined ? adoptLegacyDataDirectory() : { kind: 'nothing-to-do' };

  const filename = resolve(chosen ?? defaultDataPath());
  mkdirSync(dirname(filename), { recursive: true });
  const blobDirectory = defaultBlobPath(filename);

  const store = openSqliteStore({ filename });
  const api = createApi({ store, blobs: openDirectoryBlobStore({ directory: blobDirectory }) });
  const bound = await api.listen(port);

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
          listening: `http://127.0.0.1:${bound.port}`,
          data: filename,
          blobs: blobDirectory,
          ...(adoption.kind === 'nothing-to-do' ? {} : { dataDirectory: adoption }),
        })
      : (notice === undefined ? '' : `${notice}\n`) +
          `sbscore listening on http://127.0.0.1:${bound.port}\n  charts in ${filename}\n` +
          `  cached exports in ${blobDirectory}\n  stop with ctrl-c`,
  );

  const stop = () => {
    void api.close().then(() => {
      store.close();
      process.exit(EXIT.ok);
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  // Resolve never: the process's job from here is to keep listening.
  return new Promise<ExitCode>(() => {});
}
