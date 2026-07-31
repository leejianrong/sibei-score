import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createApi, openSqliteStore } from '@sibei/api';
import type { Flags } from './args.js';
import { optionalPort } from './args.js';
import type { Io } from './commands.js';
import { EXIT } from './exit-codes.js';
import type { ExitCode } from './exit-codes.js';

/**
 * `sibei serve` — the thing that runs the API.
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

/** Where the library lives. XDG-ish, and overridable, because a test wants a throwaway one. */
export function defaultDataPath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.local', 'share');
  return join(base, 'sibei', 'scores.db');
}

export async function serve(flags: Flags, io: Io, json: boolean): Promise<ExitCode> {
  const port = optionalPort(flags, 'port') ?? DEFAULT_PORT;
  const filename = resolve(flags.options.get('data') ?? process.env.SIBEI_DATA ?? defaultDataPath());
  mkdirSync(dirname(filename), { recursive: true });

  const store = openSqliteStore({ filename });
  const api = createApi({ store });
  const bound = await api.listen(port);

  // The one place a store path is legitimately printed: the operator asked to start a server and
  // wants to know where their charts are. It never reaches a log line or a response body (ADR-0029).
  io.out(
    json
      ? JSON.stringify({ listening: `http://127.0.0.1:${bound.port}`, data: filename })
      : `sibei listening on http://127.0.0.1:${bound.port}\n  charts in ${filename}\n  stop with ctrl-c`,
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
