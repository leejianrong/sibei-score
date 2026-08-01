import { statSync, writeFileSync } from 'node:fs';
import { projectScore } from '@sibei/model';
import type { KeySignature, NoteValue, TimeSignature } from '@sibei/model';
import type { MetaSetPayload, Operation, ScoreCreatePayload } from '@sibei/api';
import { optionalNumber, parseDuration, parseFlags, required, requiredPositional } from './args.js';
import type { Flags } from './args.js';
import { CliError, createClient } from './client.js';
import type { Client, ExportQuery } from './client.js';
import { EXIT } from './exit-codes.js';
import type { ExitCode } from './exit-codes.js';
import { fallbackName, outputPathFor } from './output.js';
import { serve } from './serve.js';

/**
 * The verbs (ADR-0008). Imperative, plus `batch` for a transactional list — no document-patch
 * endpoint, because an LLM regenerating a whole document drops and mangles fields, and one
 * accept/reject tells it nothing about what went wrong.
 *
 * `--json` on everything, because an agent should never have to parse prose. Every verb prints either
 * a human line or a JSON object, never both and never a mixture.
 *
 * Every capability is an op with a CLI verb and (later) a UI control, or it is not built (Q79). The
 * verb set here matches the operations V2c implements exactly — nothing is reachable from one surface
 * and not the other.
 */

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export interface RunOptions {
  io: Io;
  /** Injected so tests can run against a server on an ephemeral port without an env var. */
  baseUrl?: string;
  /** Injected so a test can drive the commands without a socket at all. */
  client?: Client;
  /**
   * What a relative output path is relative to. The process's working directory in real use;
   * injected so a test can write into a temp directory rather than changing the process's.
   */
  cwd?: string;
}

const USAGE = `sbscore — a jazz lead sheet, from the command line

  sbscore serve [--port N] [--data PATH]   run the local API
  sbscore new [--title T] [--composer C] [--key K] [--time 4/4]
              [--bars N] [--pickup] [--id ID]
  sbscore list
  sbscore open <id>                        the full document, as JSON
  sbscore show <id>                        the text projection
  sbscore export <id> [--pdf] [-o PATH] [--paper a4|letter] [--font normal|jazz]
  sbscore rm <id>
  sbscore meta set <id> [--title T] [--composer C] [--style S] [--key K] [--time 4/4]
  sbscore note add <id> <address> --pitch Eb5 --dur 8
  sbscore note set <id> <address> [--pitch Eb5] [--dur 8] [--tie start|stop|both|none]
  sbscore note rm  <id> <address>
  sbscore rest add <id> <address> --dur 4
  sbscore rest rm  <id> <address>
  sbscore batch <id> --ops '[{"type":"note.add",...}]'

Addresses (ADR-0007):  bar12.beat3  ·  bar12.n3  ·  note-17
  Onsets only. A beat with nothing on it is an error listing the bar's real onsets.
  \`sbscore show\` prints the addresses this CLI accepts, so you never have to guess one.

Export:  --pdf is the only format this build has, and it is the default.
  Without -o the file is written to the working directory, named after the chart's
  title — "Body and Soul" becomes ./Body and Soul.pdf. -o takes a file path, or a
  directory to put that name in.

Concurrency (ADR-0003):  --if-version N   on any verb that writes
  Every write names the version it expects. With the flag you pin one you read earlier
  and get exit 4 if somebody moved it since — which is the only way to be sure what you
  are overwriting. Without it the CLI reads the current version first, so an edit is
  read-modify-write and never a blind overwrite.

Everywhere:  --json   machine-readable output
             --url    the API base URL (or SBSCORE_URL)

Exit codes:  0 ok · 1 usage · 2 validation · 3 bad address · 4 stale-version conflict
             5 not found · 6 no server · 7 refused · 8 already exists
`;

export async function run(argv: readonly string[], options: RunOptions): Promise<ExitCode> {
  // `--json` comes off the raw arguments because **the parser itself can fail**, and everything
  // that can fail belongs inside the try. `sbscore new --title` with nothing after it used to throw
  // out of `run` altogether: the shell got node's unhandled-rejection stack instead of a message
  // and a code, which is precisely the contract ADR-0008 is. Found by `-o` with no path after it.
  const json = argv.includes('--json');

  try {
    const flags = parseFlags(argv);
    if (flags.positional.length === 0 || flags.switches.has('help')) {
      options.io.out(USAGE);
      return flags.switches.has('help') ? EXIT.ok : EXIT.usage;
    }
    return await dispatch(flags, options, json);
  } catch (error) {
    if (error instanceof CliError) {
      // Machine-readable on --json, a plain line otherwise. The message is the server's own where
      // the server produced it, so both surfaces say the same thing.
      options.io.err(
        json
          ? JSON.stringify({
              error: {
                kind: error.kind,
                message: error.message,
                ...(error.detail === undefined ? {} : { detail: error.detail }),
                ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }),
                ...(error.operation === undefined ? {} : { operation: error.operation }),
              },
            })
          : `sbscore: ${error.message}`,
      );
      return error.code;
    }
    options.io.err(
      json
        ? JSON.stringify({ error: { kind: 'internal', message: 'something went wrong' } })
        : `sbscore: something went wrong`,
    );
    return EXIT.usage;
  }
}

async function dispatch(flags: Flags, options: RunOptions, json: boolean): Promise<ExitCode> {
  const verb = flags.positional[0] ?? '';
  const client =
    options.client ??
    createClient(flags.options.get('url') ?? process.env.SBSCORE_URL ?? options.baseUrl);
  const io = options.io;

  switch (verb) {
    case 'serve':
      // The only verb that is not an HTTP client: it is the server.
      return serve(flags, io, json);
    case 'new':
      return create(flags, client, io, json);
    case 'list':
      return list(client, io, json);
    case 'open':
      return open(flags, client, io);
    case 'show':
      return show(flags, client, io, json);
    case 'export':
      return exportScore(flags, client, io, json, options.cwd ?? process.cwd());
    case 'rm':
      return remove(flags, client, io, json);
    case 'meta':
      return meta(flags, client, io, json);
    case 'note':
      return note(flags, client, io, json);
    case 'rest':
      return rest(flags, client, io, json);
    case 'batch':
      return batch(flags, client, io, json);
    case 'health': {
      const health = await client.health();
      io.out(json ? JSON.stringify(health) : `${health.status} · api ${health.api}`);
      return EXIT.ok;
    }
    default:
      throw new CliError(EXIT.usage, 'usage', `no such command: ${JSON.stringify(verb)}. Try --help.`);
  }
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

async function create(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const payload: ScoreCreatePayload = {
    id: flags.options.get('id') ?? `score-${stamp()}`,
  };
  const title = flags.options.get('title');
  if (title !== undefined) payload.title = title;
  const composer = flags.options.get('composer');
  if (composer !== undefined) payload.composer = composer;
  const key = flags.options.get('key');
  if (key !== undefined) payload.key = parseKey(key);
  const time = flags.options.get('time');
  if (time !== undefined) payload.time = parseTime(time);
  const bars = optionalNumber(flags, 'bars');
  if (bars !== undefined) payload.barCount = bars;
  if (flags.switches.has('pickup')) payload.pickup = true;

  const result = await client.create([{ type: 'score.create', payload }]);
  io.out(json ? JSON.stringify(result) : `${result.scoreId}  version ${result.version}`);
  return EXIT.ok;
}

async function list(client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const { scores } = await client.list();
  if (json) {
    io.out(JSON.stringify({ scores }));
    return EXIT.ok;
  }
  if (scores.length === 0) {
    io.out('no charts yet — try `sbscore new --title "Body and Soul"`');
    return EXIT.ok;
  }
  for (const score of scores) {
    const composer = score.composer === '' ? '' : `  ${score.composer}`;
    io.out(`${score.id}  v${score.version}  ${score.key}  ${score.title}${composer}`);
  }
  return EXIT.ok;
}

async function open(flags: Flags, client: Client, io: Io): Promise<ExitCode> {
  // Always JSON: the full structured dump is the thing this verb is for, and ADR-0009 requires that
  // anything the lossy projection drops stays reachable through it.
  const id = requiredPositional(flags, 1, 'a score id', 'open');
  io.out(JSON.stringify(await client.read(id), null, 2));
  return EXIT.ok;
}

async function show(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const id = requiredPositional(flags, 1, 'a score id', 'show');
  const record = await client.read(id);
  const text = projectScore(record.score);
  io.out(json ? JSON.stringify({ version: record.version, projection: text }) : text);
  return EXIT.ok;
}

/**
 * `sbscore export <id> [--pdf] [-o PATH] [--paper a4|letter] [--font normal|jazz]` (V3, R0).
 *
 * **The CLI renders nothing.** It asks the API for the bytes and writes them down — it imports no
 * `@sibei/pdf`, no `@sibei/layout` and no `@sibei/engrave`, and `tests/cli` asserts that. The
 * reason is the same one that keeps writes on one path (ADR-0002): a second renderer in the client
 * is a second thing that can disagree with the server about what a chart looks like, and "the UI
 * and the CLI cannot disagree" would stop being structurally true. With the server stopped, this
 * verb exits 6 like every other one.
 *
 * `--pdf` is **optional and the default**, not required. Every export parameter is optional with a
 * default on the route it calls, and every other verb here treats a flag the same way — `sbscore
 * export <id>` doing the one thing this build can do is the behaviour a caller expects. Naming it
 * explicitly stays available and stays meaningful when a second format arrives.
 *
 * Nothing about the paper or the face is judged here. An unrecognised one is a 422 whose message
 * lists what this build can produce, which lands on exit 2 — the same "the error is the feature"
 * bargain the address resolver makes (ADR-0008).
 */
async function exportScore(
  flags: Flags,
  client: Client,
  io: Io,
  json: boolean,
  cwd: string,
): Promise<ExitCode> {
  const id = requiredPositional(flags, 1, 'a score id', 'export');

  const query: ExportQuery = {};
  // The switch says pdf; absent, the server's default says pdf too. Only what was asked for goes
  // on the query, so there is one place that decides what a default is.
  if (flags.switches.has('pdf')) query.format = 'pdf';
  const paper = flags.options.get('paper');
  if (paper !== undefined) query.paper = paper;
  const font = flags.options.get('font');
  if (font !== undefined) query.font = font;

  const artefact = await client.exportScore(id, query);
  const path = outputPathFor({
    out: flags.options.get('out'),
    // A name off a socket is a suggestion, never a path (`output.ts`).
    suggested: artefact.filename,
    fallback: fallbackName(id, 'pdf'),
    cwd,
    isDirectory,
  });

  try {
    writeFileSync(path, artefact.bytes);
  } catch (error) {
    // A directory that is not there, or one that is not writable. Usage, because it is the path
    // the caller gave: nothing about the chart or the server was wrong.
    throw new CliError(
      EXIT.usage,
      'output',
      `cannot write ${path}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  // The bytes are never printed — a PDF down a pipe is not output, it is noise. The path is,
  // because the caller asked for a file and has to be able to find it.
  io.out(
    json
      ? JSON.stringify({
          scoreId: id,
          path,
          bytes: artefact.bytes.length,
          contentType: artefact.contentType,
        })
      : `wrote ${path}  ${artefact.bytes.length} bytes`,
  );
  return EXIT.ok;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function remove(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const id = requiredPositional(flags, 1, 'a score id', 'rm');
  await client.remove(id);
  io.out(json ? JSON.stringify({ removed: id }) : `removed ${id}`);
  return EXIT.ok;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

async function meta(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  expectSub(flags, 'set', 'meta');
  const id = requiredPositional(flags, 2, 'a score id', 'meta set');
  const payload: MetaSetPayload = {};
  const title = flags.options.get('title');
  if (title !== undefined) payload.title = title;
  const composer = flags.options.get('composer');
  if (composer !== undefined) payload.composer = composer;
  const style = flags.options.get('style');
  // An empty --style clears the line, which is nullable rather than merely absent.
  if (style !== undefined) payload.style = style === '' ? null : style;
  const key = flags.options.get('key');
  if (key !== undefined) payload.key = parseKey(key);
  const time = flags.options.get('time');
  if (time !== undefined) payload.time = parseTime(time);
  if (Object.keys(payload).length === 0) {
    throw new CliError(EXIT.usage, 'usage', 'meta set needs at least one of --title --composer --style --key --time');
  }
  return submit(flags, client, io, json, id, [{ type: 'meta.set', payload }]);
}

async function note(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const sub = flags.positional[1] ?? '';
  const id = requiredPositional(flags, 2, 'a score id', `note ${sub}`);
  const target = requiredPositional(flags, 3, 'an address', `note ${sub}`);

  if (sub === 'add') {
    const payload = {
      pitch: required(flags, 'pitch', 'note add'),
      duration: parseDuration(required(flags, 'dur', 'note add')),
      ...tieOf(flags),
    };
    return submit(flags, client, io, json, id, [{ type: 'note.add', target, payload } as Operation]);
  }
  if (sub === 'set') {
    const payload: Record<string, unknown> = { ...tieOf(flags) };
    const pitch = flags.options.get('pitch');
    if (pitch !== undefined) payload.pitch = pitch;
    const dur = flags.options.get('dur');
    if (dur !== undefined) payload.duration = parseDuration(dur);
    if (Object.keys(payload).length === 0) {
      throw new CliError(EXIT.usage, 'usage', 'note set needs at least one of --pitch --dur --tie');
    }
    return submit(flags, client, io, json, id, [{ type: 'note.set', target, payload } as Operation]);
  }
  if (sub === 'rm') {
    return submit(flags, client, io, json, id, [{ type: 'note.rm', target } as Operation]);
  }
  throw new CliError(EXIT.usage, 'usage', 'note takes add, set or rm');
}

async function rest(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const sub = flags.positional[1] ?? '';
  const id = requiredPositional(flags, 2, 'a score id', `rest ${sub}`);
  const target = requiredPositional(flags, 3, 'an address', `rest ${sub}`);

  if (sub === 'add') {
    const payload = { duration: parseDuration(required(flags, 'dur', 'rest add')) };
    return submit(flags, client, io, json, id, [{ type: 'rest.add', target, payload } as Operation]);
  }
  if (sub === 'rm') {
    return submit(flags, client, io, json, id, [{ type: 'rest.rm', target } as Operation]);
  }
  throw new CliError(EXIT.usage, 'usage', 'rest takes add or rm');
}

/**
 * `batch` is the whole of what a document-patch endpoint would have bought, without the
 * whole-document read or the structural risk (ADR-0008). One invalid operation applies none of them.
 */
async function batch(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const id = requiredPositional(flags, 1, 'a score id', 'batch');
  const raw = required(flags, 'ops', 'batch');
  let operations: Operation[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    operations = parsed as Operation[];
  } catch {
    throw new CliError(EXIT.usage, 'usage', '--ops takes a JSON array of operations');
  }
  return submit(flags, client, io, json, id, operations);
}

/**
 * Post the operations, with `--if-version` as the expected version (ADR-0003).
 *
 * **Without the flag the CLI reads the version rather than omitting it** (KAN-607). Every write must
 * name a version, so "I did not pin one" cannot mean "apply blind" — it means read-modify-write, and
 * the race window shrinks from unbounded to the millisecond between this GET and the POST. The cost
 * is one extra round trip to localhost per edit, which does not touch ADR-0008's argument for
 * imperative verbs: that was about the *agent's* context cost, and this read never enters it.
 *
 * `--if-version` keeps its meaning exactly — pin a version you read earlier, and get exit 4 if
 * somebody moved it. Which is the only way to be sure of what you are overwriting, and is what the
 * demo shows.
 */
async function submit(
  flags: Flags,
  client: Client,
  io: Io,
  json: boolean,
  id: string,
  operations: Operation[],
): Promise<ExitCode> {
  const pinned = optionalNumber(flags, 'if-version');
  const expected = pinned ?? (await client.read(id)).version;
  const result = await client.apply(id, operations, expected);
  io.out(
    json
      ? JSON.stringify(result)
      : `version ${result.version}  changed ${result.changed.join(' ') || '(nothing)'}`,
  );
  return EXIT.ok;
}

// ---------------------------------------------------------------------------
// Small parsers for things that are shell arguments rather than musical values
// ---------------------------------------------------------------------------

function expectSub(flags: Flags, expected: string, verb: string): void {
  if ((flags.positional[1] ?? '') !== expected) {
    throw new CliError(EXIT.usage, 'usage', `${verb} takes ${expected}`);
  }
}

function tieOf(flags: Flags): { tie?: string } {
  const tie = flags.options.get('tie');
  if (tie === undefined) return {};
  if (!['none', 'start', 'stop', 'both'].includes(tie)) {
    throw new CliError(EXIT.usage, 'usage', '--tie takes none, start, stop or both');
  }
  return { tie };
}

/** `Db`, `F#m`, `C` — the same spelling `formatKeySignature` prints and `sbscore show` displays. */
function parseKey(spec: string): KeySignature {
  const match = /^([A-G])(bb|b|#|##)?(m)?$/.exec(spec.trim());
  if (match === null) {
    throw new CliError(EXIT.usage, 'usage', `${JSON.stringify(spec)} is not a key; write Db, F#m or C`);
  }
  const [, tonic, accidental, minor] = match;
  const alters: Record<string, number> = { bb: -2, b: -1, '': 0, '#': 1, '##': 2 };
  return {
    tonic: (tonic ?? 'C') as KeySignature['tonic'],
    alter: (alters[accidental ?? ''] ?? 0) as KeySignature['alter'],
    mode: minor === undefined ? 'major' : 'minor',
  };
}

function parseTime(spec: string): TimeSignature {
  const match = /^(\d+)\/(\d+)$/.exec(spec.trim());
  if (match === null) {
    throw new CliError(EXIT.usage, 'usage', `${JSON.stringify(spec)} is not a time signature; write 4/4`);
  }
  return { beats: Number(match[1]), beatValue: Number(match[2]) as NoteValue };
}

/** A readable, sortable default id. Only used when `--id` is not given. */
function stamp(): string {
  return new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
}
