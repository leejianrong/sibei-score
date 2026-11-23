import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { NAV_KINDS, displayTitle, flaggedObjects, parsePitch, pitchToMidi, projectScore } from '@sibei/model';
import type { KeySignature, NavKind, NoteValue, TimeSignature } from '@sibei/model';
import type {
  BarlineSetPayload,
  EndingSetPayload,
  MetaSetPayload,
  Operation,
  ScoreCreatePayload,
  SectionSetPayload,
} from '@sibei/api';
import { optionalNumber, parseDuration, parseFlags, required, requiredPositional } from './args.js';
import type { Flags } from './args.js';
import { auth } from './auth.js';
import { CliError, DEFAULT_BASE_URL, createClient } from './client.js';
import type { AudioJobWire, Client, ExportQuery, UndoWire } from './client.js';
import { credentialsPath as defaultCredentialsPath, isReadableByOthers, resolveToken } from './credentials.js';
import { EXIT } from './exit-codes.js';
import type { ExitCode } from './exit-codes.js';
import { fallbackName, outputPathFor } from './output.js';
import { mcp } from './mcp.js';
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
  /**
   * The credentials file (V21b). Defaults to `$SBSCORE_CREDENTIALS` or `~/.config/sbscore/credentials.json`;
   * injected so a test never touches a real home directory.
   */
  credentialsPath?: string;
  /** How `auth login` waits between polls. Injected so a test can approve a code without really waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Where `auth login --token-stdin` reads from. Injected for tests. */
  readStdin?: () => Promise<string>;
  /** The MCP client's end of `sbscore mcp` (V22b): its stdin. Injected for tests; the process's own otherwise. */
  mcpInput?: Readable;
}

const USAGE = `sbscore — a jazz lead sheet, from the command line

  sbscore serve [--port N] [--data PATH] [--ui DIR] [--host ADDR] [--worker URL]   run the local API
              (--ui serves the built browser; --host defaults to 127.0.0.1, the container sets 0.0.0.0;
               --worker is the OMR worker's URL — without one, import is unavailable and all else works;
               --database-url URL serves from Postgres instead of the local SQLite file, and --blobs DIR
               places the scans and export cache; see docs/hosting.md;
               --redis-url URL (SBSCORE_REDIS_URL) shares change streams and rate limits across API
               processes; --allowed-hosts a,b (SBSCORE_ALLOWED_HOSTS) admits more hostnames;
               rate limits and quotas are on in hosted mode, tuned by SBSCORE_LIMIT_* / SBSCORE_QUOTA_*;
               hosted mode — GitHub sign-in, one library per user — is on only when --public-url,
               --github-client-id and SBSCORE_GITHUB_CLIENT_SECRET are all set; none set means local)
  sbscore new [--title T] [--composer C] [--key K] [--time 4/4]
              [--bars N] [--pickup] [--id ID]
  sbscore list
  sbscore open <id>                        the full document, as JSON
  sbscore show <id>                        the text projection
  sbscore check <id> [--strict]            list every flagged object with its address and reasons (--strict: exit 2 if any)
  sbscore export <id> [--pdf|--musicxml|--svg] [-o PATH] [--paper a4|letter] [--font normal|jazz]
              [--page-numbers[=top-right|…]] [--page-number-format n|page|of] [--page-number-first yes|no]
              [--blank-staves]   fill the rest of the last PDF page with empty staves
              [--written]   write each transposing part at its own written pitch (the print is concert by default)
              [--no-bar-numbers]   leave the bar numbers off the PDF (they head each line by default)
              [--for bb-trumpet|bb-tenor|eb-alto|eb-bari|f-horn]
  sbscore rm <id>
  sbscore import <file>...                 OMR a photo/scan into a new chart (a draft to correct)
  sbscore import FILE.musicxml|.xml|.mxl   a MusicXML file into an editable draft (no worker; --musicxml forces it)
  sbscore import --note-events FILE... [--split-point 60|C4]   a NoteEvents v1 file from the audio engine into a draft (no worker needed);
              several files are one stem each, imported as one multi-part score on one bar grid;
              a piano file's hands pivot on the split point (default middle C)
              (several files = one chart, pages in order (Q26); title/key/meter default, set them after)
  sbscore reparse <id> [--engine oemer|heuristic]   re-run OMR on an imported chart's kept scans
  sbscore reparse <id> --split-point 62   re-split a piano NoteEvents draft at another pitch (a NEW draft; no re-upload)
              (produces a NEW draft — the original and its corrections survive; no re-upload)
  sbscore audio submit <file> [--instrument piano]   upload audio to be transcribed; prints the job id
  sbscore audio list|show <id>|retry <id>|rm <id>    look at, requeue or delete an audio job
  sbscore audio usage                      audio-seconds transcribed this month
              (a transcription runs on a separate worker; the job waits until one picks it up)
  sbscore duplicate <id> [--id NEW]        copy a chart to a new one, fresh history
  sbscore meta set <id> [--title T] [--subtitle S] [--composer C] [--arranger A] [--style S] [--key K] [--time 4/4]
              [--signature-policy every|first|page] [--bars-per-system N]   bars to a line (1-8, default 4)
              [--footer TEXT] [--footer-pages first|last|all]   page footer: copyright / credit (\\n = new line)
              [--tempo 4=120]   metronome mark above the first bar (4., 2, 8 units; empty removes it)
              [--chord-style standard|dash|words|real-book]   how chords print: Δ/m7, -7, maj/min, MA7/MI7
              [--layout lead-sheet|score]   how systems break: the four-bar grid, or by width (a score of several staves)
  sbscore note add <id> <address> --pitch Eb5 --dur 8 [--accidental auto|show|hide|paren] [--spell] [--artic staccato,accent,marcato]
  sbscore note add <id> <address> --drum snare --dur 8 [--head x|diamond|circle-x|normal]   a drum, on a percussion staff
  sbscore note set <id> <address> [--pitch Eb5] [--dur 8] [--tie start|stop|both|none] [--accidental auto|show|hide|paren] [--spell|--unspell]
              [--artic staccato,accent,marcato|none]   marks over or under the head, by stem
              [--drum NAME|none] [--head x|diamond|circle-x|normal|default]   a drum, on a percussion staff
  sbscore note rm  <id> <address>   (bar3.n2.Eb5 names one pitch of a chord; note add onto a held onset stacks a chord)
  sbscore note move <id> <address> --to s2[.v1]   re-home a note, chord or one pitch (bar3.n2.E4) on another staff, same time
  sbscore hands move <id> <bars> --from s1 --to s2 [--below C4|--above C4]   a bar range (3-8) to the other hand; a chord splits at the pitch
  sbscore rest add <id> <address> --dur 4
  sbscore rest rm  <id> <address>
  sbscore chord set <id> <address> --text F#m7b5 [--spell]
  sbscore chord rm  <id> <address>
  sbscore text set <id> <address> --text '(unis.)' [--until bar8]   a text direction above the staff; --until adds a dashed line to bar 8's end
  sbscore text rm  <id> <address|annotation-id>
  sbscore transpose <id> --to Eb           change the concert key (ADR-0016)
  sbscore bar add <id> [--after <bar>] [--count N]   add empty bars (default: at the end); later bars renumber
  sbscore bar rm  <id> <bar>               remove an empty bar; later bars renumber
  sbscore part add <id> [--name Piano] [--instrument 0|none] [--transposition -2] [--staff-type standard|percussion|tab] [--clef bass]
  sbscore part rm  <id> <p2> [--force]     a part holding music is refused unless --force
  sbscore staff add <id> [<p1>] [--type standard|percussion|tab] [--clef treble|bass|alto|tenor|percussion]   (default: the last part)
  sbscore staff rm  <id> <s2> [--force]
  sbscore voice add <id> [<s2>]            the next free voice of a staff, 2 to 4 (omit <s2> when there is one staff)
  sbscore voice rm  <id> <s2.v2> [--force]
  sbscore clef set <id> <s2|s2.bar5> --clef treble|bass|alto|tenor|percussion|none   a staff's clef, or a change from a bar (none clears it)
  sbscore instrument set <id> [<p1>] [--name Piano] [--instrument 0|none] [--transposition -2]
  sbscore section set <id> <bar> [--letter A] [--name Bridge]   a section boundary (ADR-0021)
  sbscore section rm  <id> <bar>
  sbscore barline set <id> <bar> [--start none|repeat-start] [--end single|double|final|repeat-end]
  sbscore repeat set <id> <startBar> <endBar>   a repeat pair around startBar..endBar
  sbscore ending set <id> <bar> --numbers 1[,2] --role start|continue|stop|start-stop
  sbscore ending rm  <id> <bar>
  sbscore fermata set <id> <address>      a fermata over a note or rest
  sbscore fermata rm  <id> <address>
  sbscore grace add <id> <address> --pitch D5 [--dur 8|16|32] [--slash] [--accidental auto|show|hide|paren]
              a grace note before the note at <address> (--slash: an acciaccatura); it takes no bar time
  sbscore grace rm  <id> <grace-id|address>   one grace by its id (show prints it), or all on a note
  sbscore tuplet set <id> <address> --notes 3 [--in 2] [--over 3]   bracket --over items from <address>: --notes in the time of --in
  sbscore tuplet rm  <id> <address>        take the bracket off the tuplet holding <address>
  sbscore slur set <id> <from> <to> [--placement above|below|auto]   a slur from one note to a later one
  sbscore slur rm  <id> <slur-id|from>
  sbscore ottava set <id> <from> <to> --up|--down   an 8va (--up) or 8vb (--down) line over a run of notes
  sbscore ottava rm  <id> <ottava-id|from>
  sbscore break set <id> <bar> [--join]   end the line after <bar>; --join lets a section-start bar share the previous line
  sbscore break rm  <id> <bar>
  sbscore nav set <id> <bar> --segno|--coda|--to-coda|--fine|--dc|--ds|--dc-al-fine|--dc-al-coda|--ds-al-fine|--ds-al-coda
              a navigation mark: signs at the bar's start, jump texts at its end (a second jump replaces the first)
  sbscore nav rm  <id> <bar> [--segno|--coda|...]   remove one mark, or every mark of the bar
  sbscore batch <id> --ops '[{"type":"note.add",...}]'   (or --ops @ops.json, or --ops - for stdin)
  sbscore undo <id>                        revert the last edit or batch (ADR-0003)
  sbscore redo <id>                        reapply the last undone edit
  sbscore mcp                              serve the MCP tools over stdio (V22b): for an MCP client that
              launches a process (Claude Desktop, an editor). The same tools as a hosted server's /mcp,
              run through this CLI's credentials and --url; stdout carries only the protocol
  sbscore auth login                       sign in to a hosted server: prints a code, you approve it in the
              browser, and the CLI keeps the API token it is given (never a password or a GitHub token)
  sbscore auth login --scopes read --name ci   ask for fewer scopes and a name; the approval page
              pre-fills them, and what the person approves is what the token gets
  sbscore auth login --token-stdin         the headless fallback: read a token on stdin and keep it
              (--token VALUE works too, but leaves the token in your shell history)
  sbscore auth status                      who this server thinks you are; exit 7 when signed out
  sbscore auth token                       print the token, bare, so $(sbscore auth token) is a token
  sbscore auth logout                      forget the credential for this server

Where a verb takes <bar>, write 12 or bar12.
Addresses (ADR-0007):  bar12  ·  bar12.beat3  ·  bar12.n3  ·  note-17
  A score with more than one staff or voice needs a qualifier: s2.bar12.beat3 (staff 2), s2.v2.bar12.n3 (staff 2, voice 2);
  a bare bar12.n3 is then an error listing the candidates. note/rest/tuplet/slur/ottava/fermata/grace also take
  --staff N --voice M, which write the qualifier for you. Chords and text need none (they sit on one lane).
  Onsets only. A beat with nothing on it is an error listing the bar's real onsets.
  \`sbscore show\` prints the addresses this CLI accepts, so you never have to guess one.

Export:  --pdf (the default) or --musicxml. MusicXML is a codec at the edges (ADR-0004);
  it is lossy in known ways and ignores --paper, --font, --page-numbers, --blank-staves and --no-bar-numbers, which are page choices.
  --blank-staves fills the rest of the last PDF page with empty ruled staves to write in (off by default).
  --written prints a part that has its own transposition (a Bb trumpet beside a concert piano) at written pitch on the
  PDF or SVG; without it a print is the concert score (ADR-0016). MusicXML always writes the transposed part.
  --no-bar-numbers leaves the bar number off the head of each line (drawn by default).
  --svg writes each page as an SVG, the same markup the browser draws, one file per page ("Title - page 2.svg"):
  give -o a directory for a chart of several pages. There is no --png: rasterise the SVG with your own tool.
  --page-numbers prints a number on each PDF page (off by default): bare it is top-right, or name a
  place — top|bottom with left|center|right, as top-center. --page-number-format is n (2), page
  (Page 2) or of (Page 2 of 3); --page-number-first no leaves page 1 bare.
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

Signing in (hosted servers only; a local one has no accounts):  a credential is kept per server in
  ~/.config/sbscore/credentials.json (mode 0600) and sent only to the server it was issued by.
  SBSCORE_TOKEN supplies one instead — what a CI job uses — and wins over the file.

Exit codes:  0 ok · 1 usage · 2 validation · 3 bad address · 4 stale-version conflict
             5 not found · 6 no server · 7 refused · 8 already exists · 9 rate limit or quota
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
  const io = options.io;
  // No trailing slash: every path is appended to this with a leading one, and `http://host/` + `/v1/…` is a
  // 404 on every verb. Found by the credentials test, which files a token by URL and so had to ask.
  const baseUrl = (flags.options.get('url') ?? process.env.SBSCORE_URL ?? options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const credentials = options.credentialsPath ?? defaultCredentialsPath();
  // The token for *this* server, from SBSCORE_TOKEN or the file. Filed by URL, so it is only ever sent to
  // the server that issued it (`credentials.ts`).
  const resolved = verb === 'serve' ? undefined : resolveToken(credentials, baseUrl);
  if (resolved?.source === 'file' && isReadableByOthers(credentials)) {
    io.err(
      `sbscore: ${credentials} is readable by other users, and it holds an API token. Run: chmod 600 ${JSON.stringify(credentials)}`,
    );
  }
  const client = options.client ?? createClient(baseUrl, resolved === undefined ? {} : { token: resolved.token });

  switch (verb) {
    case 'serve':
      // The only verb that is not an HTTP client: it is the server.
      return serve(flags, io, json);
    case 'auth':
      return auth(flags, {
        baseUrl,
        credentialsPath: credentials,
        io,
        json,
        client,
        resolved,
        sleep: options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
        readStdin: options.readStdin ?? readAllStdin,
        now: () => new Date(),
      });
    case 'mcp':
      // stdout is the protocol, so nothing else may write to it: diagnostics go to stderr (`io.err`).
      return mcp(client, { input: options.mcpInput ?? process.stdin, write: io.out, log: io.err });
    case 'new':
      return create(flags, client, io, json);
    case 'list':
      return list(client, io, json);
    case 'open':
      return open(flags, client, io);
    case 'show':
      return show(flags, client, io, json);
    case 'check':
      return check(flags, client, io, json);
    case 'export':
      return exportScore(flags, client, io, json, options.cwd ?? process.cwd());
    case 'rm':
      return remove(flags, client, io, json);
    case 'duplicate':
      return duplicate(flags, client, io, json);
    case 'import':
      return importChart(flags, client, io, json, options.cwd ?? process.cwd());
    case 'reparse':
      return reparse(flags, client, io, json);
    case 'audio':
      return audio(flags, client, io, json, options.cwd ?? process.cwd());
    case 'meta':
      return meta(flags, client, io, json);
    case 'note':
      return note(flags, client, io, json);
    case 'hands':
      return hands(flags, client, io, json);
    case 'rest':
      return rest(flags, client, io, json);
    case 'chord':
      return chord(flags, client, io, json);
    case 'text':
      return text(flags, client, io, json);
    case 'transpose':
      return transpose(flags, client, io, json);
    case 'bar':
      return bar(flags, client, io, json);
    case 'part':
    case 'staff':
    case 'voice':
    case 'clef':
    case 'instrument':
      return structure(verb as 'part' | 'staff' | 'voice' | 'clef' | 'instrument', flags, client, io, json);
    case 'section':
      return section(flags, client, io, json);
    case 'barline':
      return barline(flags, client, io, json);
    case 'repeat':
      return repeat(flags, client, io, json);
    case 'fermata':
      return fermata(flags, client, io, json);
    case 'grace':
      return grace(flags, client, io, json);
    case 'tuplet':
      return tuplet(flags, client, io, json);
    case 'slur':
      return slur(flags, client, io, json);
    case 'ottava':
      return ottava(flags, client, io, json);
    case 'break':
      return lineBreak(flags, client, io, json);
    case 'nav':
      return nav(flags, client, io, json);
    case 'ending':
      return ending(flags, client, io, json);
    case 'batch':
      return batch(flags, client, io, json, options.readStdin ?? readAllStdin);
    case 'undo':
      return move('undo', flags, client, io, json);
    case 'redo':
      return move('redo', flags, client, io, json);
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
    // An unnamed chart prints the browser's own word (KAN-609), not a blank column with trailing spaces.
    io.out(`${score.id}  v${score.version}  ${score.key}  ${displayTitle(score.title)}${composer}`);
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
 * `sbscore check <id> [--strict]` (SIB2-193): every flagged object — an unparsed chord, a
 * low-confidence note, a bar that does not fill the meter — with an address a verb accepts and the
 * reasons, so an agent need not scan `show` for `!`. Exit 0 whatever is found, unless `--strict`,
 * which exits 2 (the chart is not clean) when anything is flagged. It lists; it fixes nothing.
 */
async function check(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const id = requiredPositional(flags, 1, 'a score id', 'check');
  const record = await client.read(id);
  const flagged = flaggedObjects(record.score);
  if (json) {
    io.out(JSON.stringify({ version: record.version, flagged }));
  } else if (flagged.length === 0) {
    io.out('nothing flagged');
  } else {
    for (const f of flagged) {
      const what = f.text === null ? f.kind : `${f.kind} ${JSON.stringify(f.text)}`;
      io.out(`${f.address}  ${what}  ${f.reasons.join(', ')}`);
    }
  }
  return flagged.length > 0 && flags.switches.has('strict') ? EXIT.validation : EXIT.ok;
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
  // `--pdf` (the default) or `--musicxml` (V8d), never both. Only what was asked for goes on the
  // query, so the server stays the one place that decides what a default is — but a chosen format is
  // sent, and it also fixes the fallback filename's extension below.
  if (flags.switches.has('png')) {
    // A rasteriser is a native binding, and none ships in the CLI or the server (ADR-0031 keeps resvg a
    // build-time tool). SVG is the browser's own markup, so any image tool can turn it into a PNG.
    throw new CliError(
      EXIT.usage,
      'usage',
      'there is no --png: this build ships no rasteriser. Use --svg (the browser\'s own SVG, one file per page) and convert it, e.g. rsvg-convert -z 2 page.svg -o page.png',
    );
  }
  const chosen = ['pdf', 'musicxml', 'svg'].filter((name) => flags.switches.has(name));
  if (chosen.length > 1) {
    throw new CliError(EXIT.usage, 'usage', 'choose one of --pdf, --musicxml or --svg, not several');
  }
  const format = chosen[0] ?? 'pdf';
  if (chosen.length === 1) query.format = format;
  const paper = flags.options.get('paper');
  if (paper !== undefined) query.paper = paper;
  const font = flags.options.get('font');
  if (font !== undefined) query.font = font;
  // `--for bb-trumpet` renders the written part for a transposing instrument (V6, ADR-0016). Like
  // paper and face, the server judges the name and 422s an unknown one; the CLI just forwards it.
  const instrument = flags.options.get('for');
  if (instrument !== undefined) query.instrument = instrument;
  // Page numbers (SIB2-171): bare `--page-numbers` is top-right; `--page-numbers=bottom-center` names a place.
  // `--page-numbers=none` is spelled out too. The server judges every value.
  const numbers = flags.options.get('page-numbers') ?? (flags.switches.has('page-numbers') ? 'top-right' : undefined);
  if (numbers !== undefined) query.pagenumbers = numbers;
  const numberFormat = flags.options.get('page-number-format');
  if (numberFormat !== undefined) query.pagenumberformat = numberFormat;
  const numberFirst = flags.options.get('page-number-first');
  if (numberFirst !== undefined) query.pagenumberfirst = numberFirst;
  // Empty staves to fill the last page (SIB2-181): off unless asked for.
  if (flags.switches.has('blank-staves')) query.blankstaves = 'yes';
  // A transposing part at its own written pitch on the PDF/SVG (SIB2-239); concert unless asked.
  if (flags.switches.has('written')) query.written = 'yes';
  // Bar numbers head each system by default; `--no-bar-numbers` leaves them out (SIB2-191).
  if (flags.switches.has('no-bar-numbers')) query.barnumbers = 'no';

  if (format === 'svg') return exportSvgPages(flags, client, io, json, cwd, id, query);

  const artefact = await client.exportScore(id, query);
  const path = outputPathFor({
    out: flags.options.get('out'),
    // A name off a socket is a suggestion, never a path (`output.ts`).
    suggested: artefact.filename,
    fallback: fallbackName(id, format),
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

/**
 * `export --svg` (SIB2-190): one SVG file per page. The server sends a page at a time and says how many there
 * are, so this asks for page 1, reads the count and fetches the rest. A name for a single file with several pages
 * to write would clobber itself, so that is refused before anything is written.
 */
async function exportSvgPages(
  flags: Flags,
  client: Client,
  io: Io,
  json: boolean,
  cwd: string,
  id: string,
  query: ExportQuery,
): Promise<ExitCode> {
  const first = await client.exportScore(id, { ...query, page: '1' });
  const pages = first.pages ?? 1;
  const out = flags.options.get('out');
  const namesADirectory = out !== undefined && (out.endsWith('/') || isDirectory(resolve(cwd, out)));
  if (pages > 1 && out !== undefined && !namesADirectory) {
    throw new CliError(
      EXIT.usage,
      'output',
      `this chart has ${pages} pages, one SVG each: -o must name a directory (end it with /), not the file ${out}`,
    );
  }

  const written: { page: number; path: string; bytes: number }[] = [];
  for (let page = 1; page <= pages; page += 1) {
    const artefact = page === 1 ? first : await client.exportScore(id, { ...query, page: String(page) });
    const path = outputPathFor({
      out,
      suggested: artefact.filename,
      fallback: fallbackName(id, 'svg').replace(/\.svg$/, ` - page ${page}.svg`),
      cwd,
      isDirectory,
    });
    try {
      writeFileSync(path, artefact.bytes);
    } catch (error) {
      throw new CliError(
        EXIT.usage,
        'output',
        `cannot write ${path}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    written.push({ page, path, bytes: artefact.bytes.length });
  }

  io.out(
    json
      ? JSON.stringify({ scoreId: id, pages: written, contentType: first.contentType })
      : written.map((file) => `wrote ${file.path}  ${file.bytes} bytes`).join('\n'),
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

/**
 * `duplicate` copies a chart to a new one with a fresh history (V8c). `--id` names the copy;
 * without it the server mints one from the source (`<id>-copy`). It carries no `--if-version`: a
 * duplicate creates rather than overwrites, so there is nothing to be stale against.
 */
async function duplicate(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const id = requiredPositional(flags, 1, 'a score id', 'duplicate');
  const result = await client.duplicate(id, flags.options.get('id'));
  io.out(json ? JSON.stringify(result) : `duplicated ${id} to ${result.scoreId}`);
  return EXIT.ok;
}

/**
 * `sbscore import <file>...` — OMR one or more images into a new chart (V11, R5). The images become one
 * job (ADR-0001, Q26); the CLI waits for it and reports the score it produced, or the diagnostic if the
 * recogniser failed (Q80) or the image had no staff (ADR-0018/Q28). Every parse is a draft to correct
 * (ADR-0019), which the success line says out loud.
 */
async function importChart(
  flags: Flags,
  client: Client,
  io: Io,
  json: boolean,
  cwd: string,
): Promise<ExitCode> {
  const paths = flags.positional.slice(1);
  if (flags.switches.has('note-events')) return importNoteEvents(paths, flags, client, io, json, cwd);
  if (flags.switches.has('musicxml') || (paths.length === 1 && isMusicXmlPath(paths[0]!))) return importMusicXml(paths, client, io, json, cwd);
  if (paths.length === 0) {
    throw new CliError(EXIT.usage, 'usage', 'import needs at least one image file: `sbscore import chart.png`');
  }

  const images = paths.map((path) => {
    const resolved = isAbsolute(path) ? path : `${cwd}/${path}`;
    let bytes: Buffer;
    try {
      bytes = readFileSync(resolved);
    } catch (error) {
      // A path the caller gave that is not there or not readable — usage, like a bad -o path.
      throw new CliError(
        EXIT.usage,
        'input',
        `cannot read ${path}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    return { filename: basename(path), bytes, contentType: contentTypeOf(path) };
  });

  const job = await client.importImages(images);
  if (job.status === 'failed') {
    // A failed import committed nothing (Q80): the diagnostic is the server's, printed verbatim.
    throw new CliError(EXIT.validation, 'import-failed', `import failed: ${job.diagnostic ?? 'unknown error'}`);
  }

  const pages = paths.length === 1 ? '1 page' : `${paths.length} pages`;
  io.out(
    json
      ? JSON.stringify(job)
      : `imported ${pages} to ${job.scoreId} — a draft: open it, check the flagged bars, set key/meter/sections`,
  );
  return EXIT.ok;
}

/** `--split-point 60` (or `C4`): the MIDI pitch a piano import pivots its hands on. The server judges the range. */
function splitPointOf(flags: Flags): number | undefined {
  const raw = flags.options.get('split-point');
  if (raw === undefined) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  try {
    return pitchToMidi(parsePitch(raw));
  } catch {
    throw new CliError(EXIT.usage, 'usage', `--split-point is a MIDI number like 60 or a pitch like C4, not ${JSON.stringify(raw)}`);
  }
}

/**
 * `sbscore import --note-events FILE` — a NoteEvents v1 document from the audio engine becomes a draft
 * (ADR-0040). Needs no OMR worker. The bytes go up unchanged and the server validates; a refused file is
 * exit 2 (validation) and creates nothing. The draft's barring and doubtful notes are flagged for review.
 */
async function importNoteEvents(paths: string[], flags: Flags, client: Client, io: Io, json: boolean, cwd: string): Promise<ExitCode> {
  if (paths.length === 0) {
    throw new CliError(EXIT.usage, 'usage', 'import --note-events needs a file: `sbscore import --note-events take1.json` (several files are one stem each)');
  }
  const files = paths.map((path) => {
    try {
      return readFileSync(isAbsolute(path) ? path : `${cwd}/${path}`);
    } catch (error) {
      throw new CliError(EXIT.usage, 'input', `cannot read ${path}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  });
  // One file goes up unchanged; several are one stem each, sent as a JSON array the server checks as a set (SIB2-147).
  const bytes = files.length === 1 ? files[0]! : Buffer.from(`[${files.map((f) => f.toString('utf8').trim()).join(',')}]`);
  const job = await client.importNoteEvents(bytes, splitPointOf(flags));
  if (job.status === 'failed') {
    throw new CliError(EXIT.validation, 'import-failed', `import failed: ${job.diagnostic ?? 'unknown error'}`);
  }
  io.out(
    json
      ? JSON.stringify(job)
      : `imported ${files.length === 1 ? 'NoteEvents' : `${files.length} NoteEvents stems`} to ${job.scoreId} — a draft: open it, check the flagged bars and notes, set key/meter/sections` +
          (job.diagnostic === null ? '' : `\n${job.diagnostic}`),
  );
  return EXIT.ok;
}

function isMusicXmlPath(path: string): boolean {
  return ['.musicxml', '.xml', '.mxl'].includes(extname(path).toLowerCase());
}

/**
 * `sbscore import FILE.musicxml` (or `.xml`, or a compressed `.mxl`; `--musicxml` forces it for any name) — a
 * MusicXML file becomes an editable draft with a fresh history (SIB2-152). Needs no OMR worker. The server
 * validates and unpacks it; a refused file is exit 2 and creates nothing. **Whatever the codec had to drop**
 * (lyrics, dynamics, chord tones, a fifth voice, ...) is printed under the success line, and is in
 * the job's `diagnostic` under `--json`, so a lossy import is never silent.
 */
async function importMusicXml(paths: string[], client: Client, io: Io, json: boolean, cwd: string): Promise<ExitCode> {
  if (paths.length !== 1) {
    throw new CliError(EXIT.usage, 'usage', 'import takes exactly one MusicXML file: `sbscore import tune.musicxml`');
  }
  const path = paths[0]!;
  let bytes: Buffer;
  try {
    bytes = readFileSync(isAbsolute(path) ? path : `${cwd}/${path}`);
  } catch (error) {
    throw new CliError(EXIT.usage, 'input', `cannot read ${path}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  const job = await client.importMusicXml(bytes, extname(path).toLowerCase() === '.mxl');
  if (job.status === 'failed') {
    throw new CliError(EXIT.validation, 'import-failed', `import failed: ${job.diagnostic ?? 'unknown error'}`);
  }
  io.out(
    json
      ? JSON.stringify(job)
      : `imported MusicXML to ${job.scoreId} — an editable draft` +
          (job.diagnostic === null ? '' : `\nnot imported (MusicXML this chart has no home for):\n${job.diagnostic.split('\n').map((w) => `  - ${w}`).join('\n')}`),
  );
  return EXIT.ok;
}

/**
 * `sbscore reparse <id> [--engine oemer|heuristic]` — re-run OMR on an imported chart's retained
 * source images into a **new** draft (V14e, ADR-0019). Nothing is re-uploaded: the server reuses the
 * scans the original import kept. The new draft is the safe choice — the original chart and any
 * corrections on it survive — so the CLI reports the new id, never touches the old one, and waits for
 * the job like `import`. `--engine` picks the recogniser (heuristic on a small host, oemer where RAM
 * allows); without it the worker keeps its default. A chart with no scan behind it (hand-authored or
 * duplicated) is a clean validation error from the server, printed verbatim.
 */
async function reparse(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const id = requiredPositional(flags, 1, 'a score id', 'reparse');
  const engine = flags.options.get('engine');
  const job = await client.reparse(id, engine, splitPointOf(flags));
  if (job.status === 'failed') {
    throw new CliError(EXIT.validation, 'reparse-failed', `reparse failed: ${job.diagnostic ?? 'unknown error'}`);
  }
  io.out(
    json
      ? JSON.stringify(job)
      : `re-parsed ${id} to a new draft ${job.scoreId} — open it, check the flagged bars, set key/meter/sections`,
  );
  return EXIT.ok;
}

/**
 * `sbscore audio submit|list|show|retry|rm` (SIB2-137). An audio job is the second kind of durable job
 * beside import (ADR-0001): `submit` uploads the file and returns at once with the job id, because the
 * transcription runs on a separate worker and can take minutes. Everything after that is a read of the
 * job (`show`), a requeue of a failed one (`retry`) or a delete (`rm`, which removes the audio too).
 */
async function audio(flags: Flags, client: Client, io: Io, json: boolean, cwd: string): Promise<ExitCode> {
  const sub = flags.positional[1];
  const line = (job: AudioJobWire) =>
    `${job.id}  ${job.status}${job.progress === null ? '' : ` ${Math.round(job.progress.fraction * 100)}% (${job.progress.stage})`}  ${job.filename ?? '-'}`;

  switch (sub) {
    case 'submit': {
      const path = flags.positional[2];
      if (path === undefined) throw new CliError(EXIT.usage, 'usage', 'audio submit needs a file: `sbscore audio submit take.wav`');
      let bytes: Buffer;
      try {
        bytes = readFileSync(isAbsolute(path) ? path : `${cwd}/${path}`);
      } catch (error) {
        throw new CliError(EXIT.usage, 'input', `cannot read ${path}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      const instrument = flags.options.get('instrument');
      const job = await client.audioSubmit({
        filename: basename(path),
        bytes,
        contentType: audioContentTypeOf(path),
        ...(instrument === undefined ? {} : { instrument }),
      });
      io.out(json ? JSON.stringify({ job }) : `${job.id}\n(queued — check it with \`sbscore audio show ${job.id}\`)`);
      return EXIT.ok;
    }
    case 'list': {
      const { jobs } = await client.audioList();
      io.out(json ? JSON.stringify({ jobs }) : jobs.length === 0 ? 'no audio jobs' : jobs.map(line).join('\n'));
      return EXIT.ok;
    }
    case 'show': {
      const { job } = await client.audioShow(requiredPositional(flags, 2, 'an audio job id', 'audio show'));
      io.out(
        json
          ? JSON.stringify({ job })
          : [
              line(job),
              ...(job.diagnostic === null
                ? []
                : job.status === 'failed'
                  ? [`failed: ${job.diagnostic}${job.diagnosticKind === null ? '' : ` (${job.diagnosticKind})`}`]
                  : job.diagnostic.split('\n').map((w) => `warning: ${w}`)),
              ...(job.scoreId === null ? [] : [`draft: ${job.scoreId}  (sbscore open ${job.scoreId})`]),
              ...(job.durationSeconds === null ? [] : [`audio seconds: ${job.durationSeconds}`]),
            ].join('\n'),
      );
      return EXIT.ok;
    }
    case 'retry': {
      const { job } = await client.audioRetry(requiredPositional(flags, 2, 'an audio job id', 'audio retry'));
      io.out(json ? JSON.stringify({ job }) : line(job));
      return EXIT.ok;
    }
    case 'usage': {
      const { usage } = await client.audioUsage();
      io.out(
        json
          ? JSON.stringify({ usage })
          : `${Math.round(usage.seconds * 10) / 10} audio seconds in ${usage.jobs} ${usage.jobs === 1 ? 'job' : 'jobs'} this month (${usage.periodStart.slice(0, 10)} to ${usage.periodEnd.slice(0, 10)})` +
            (usage.capSeconds === null ? '' : `, of ${usage.capSeconds} allowed`),
      );
      return EXIT.ok;
    }
    case 'rm': {
      const id = requiredPositional(flags, 2, 'an audio job id', 'audio rm');
      await client.audioRemove(id);
      io.out(json ? JSON.stringify({ removed: id }) : `removed ${id}`);
      return EXIT.ok;
    }
    default:
      throw new CliError(EXIT.usage, 'usage', 'audio needs submit, list, show, retry, rm or usage');
  }
}

/** The media type for an audio file, from its extension. The server checks the declared type against an allow-list. */
function audioContentTypeOf(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.wav':
      return 'audio/wav';
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
    case '.mp4':
      return 'audio/mp4';
    case '.aac':
      return 'audio/aac';
    case '.flac':
      return 'audio/flac';
    case '.ogg':
    case '.oga':
      return 'audio/ogg';
    case '.webm':
      return 'audio/webm';
    default:
      return 'application/octet-stream';
  }
}

/** The media type for a part, from its extension. The server detects the real format from content. */
function contentTypeOf(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    default:
      return 'application/octet-stream';
  }
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/');
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
  // A literal \n is a line break, so a second composer is `--composer 'A\nB'` (SIB2-180).
  if (composer !== undefined) payload.composer = composer.replace(/\\n/g, '\n');
  const subtitle = flags.options.get('subtitle');
  if (subtitle !== undefined) payload.subtitle = subtitle === '' ? null : subtitle;
  const arranger = flags.options.get('arranger');
  if (arranger !== undefined) payload.arranger = arranger === '' ? null : arranger;
  const style = flags.options.get('style');
  // An empty --style clears the line, which is nullable rather than merely absent.
  if (style !== undefined) payload.style = style === '' ? null : style;
  const key = flags.options.get('key');
  if (key !== undefined) payload.key = parseKey(key);
  const time = flags.options.get('time');
  if (time !== undefined) payload.time = parseTime(time);
  // The page footer (SIB2-172): a literal \n in the text is a line break; an empty --footer removes it.
  const footer = flags.options.get('footer');
  if (footer !== undefined) payload.footer = footer === '' ? null : footer.replace(/\\n/g, '\n');
  const footerPages = flags.options.get('footer-pages');
  if (footerPages !== undefined) payload.footerPages = footerPages as 'first' | 'last' | 'all';
  const policy = flags.options.get('signature-policy');
  if (policy !== undefined) payload.signaturePolicy = policy as 'every' | 'first' | 'page';
  const perSystem = flags.options.get('bars-per-system');
  if (perSystem !== undefined) {
    if (perSystem !== '' && !/^\d+$/.test(perSystem)) {
      throw new CliError(EXIT.usage, 'usage', `--bars-per-system takes a whole number, not ${JSON.stringify(perSystem)}`);
    }
    payload.barsPerSystem = perSystem === '' ? null : Number(perSystem);
  }
  const tempo = flags.options.get('tempo');
  if (tempo !== undefined) payload.tempo = tempo === '' ? null : parseTempo(tempo);
  const chordStyle = flags.options.get('chord-style');
  if (chordStyle !== undefined) payload.chordStyle = chordStyle as NonNullable<MetaSetPayload['chordStyle']>;
  const layout = flags.options.get('layout');
  if (layout !== undefined) payload.layout = layout === '' ? null : (layout as 'lead-sheet' | 'score');
  if (Object.keys(payload).length === 0) {
    throw new CliError(
      EXIT.usage,
      'usage',
      'meta set needs at least one of --title --subtitle --composer --arranger --style --key --time --footer --footer-pages --signature-policy --chord-style --bars-per-system --tempo --layout',
    );
  }
  return submit(flags, client, io, json, id, [{ type: 'meta.set', payload }]);
}

/** `--head x` or `--head default` (back to the drum's own head). The server judges the names (slice 6). */
function headOf(flags: Flags): { head?: string | null } {
  const raw = flags.options.get('head');
  if (raw === undefined) return {};
  return { head: raw === 'default' || raw === '' ? null : raw };
}

/** `--artic staccato,accent` or `--artic none` (SIB2-179). The server judges the names. */
function articOf(flags: Flags): { articulations?: string[] } {
  const raw = flags.options.get('artic');
  if (raw === undefined) return {};
  return { articulations: raw === 'none' || raw === '' ? [] : raw.split(',').map((part) => part.trim()) };
}

async function note(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const sub = flags.positional[1] ?? '';
  const id = requiredPositional(flags, 2, 'a score id', `note ${sub}`);
  const target = qualified(flags, requiredPositional(flags, 3, 'an address', `note ${sub}`));

  if (sub === 'add') {
    const drum = flags.options.get('drum');
    const payload = {
      // A drum is written where the drum map puts it, so it takes no pitch (the server says which drums exist).
      ...(drum === undefined ? { pitch: required(flags, 'pitch', 'note add') } : { drum }),
      ...headOf(flags),
      duration: parseDuration(required(flags, 'dur', 'note add')),
      ...tieOf(flags),
      ...accidentalOf(flags),
      ...spellOf(flags),
      ...articOf(flags),
    };
    return submit(flags, client, io, json, id, [{ type: 'note.add', target, payload } as Operation]);
  }
  if (sub === 'set') {
    const payload: Record<string, unknown> = { ...tieOf(flags), ...accidentalOf(flags), ...spellOf(flags), ...articOf(flags), ...headOf(flags) };
    const drum = flags.options.get('drum');
    if (drum !== undefined) payload.drum = drum === 'none' || drum === '' ? null : drum;
    const pitch = flags.options.get('pitch');
    if (pitch !== undefined) payload.pitch = pitch;
    const dur = flags.options.get('dur');
    if (dur !== undefined) payload.duration = parseDuration(dur);
    if (Object.keys(payload).length === 0) {
      throw new CliError(EXIT.usage, 'usage', 'note set needs at least one of --pitch --dur --tie --accidental --spell --artic --drum --head');
    }
    return submit(flags, client, io, json, id, [{ type: 'note.set', target, payload } as Operation]);
  }
  if (sub === 'rm') {
    return submit(flags, client, io, json, id, [{ type: 'note.rm', target } as Operation]);
  }
  if (sub === 'move') {
    const to = flags.options.get('to');
    if (to === undefined) throw new CliError(EXIT.usage, 'usage', 'note move needs --to, a staff or voice like s2 or s2.v1');
    return submit(flags, client, io, json, id, [{ type: 'note.move', target, payload: { to } } as Operation]);
  }
  throw new CliError(EXIT.usage, 'usage', 'note takes add, set, rm or move');
}

/**
 * `hands move <id> <bars> --from s1 --to s2 [--below C4 | --above C4]` (SIB2-244): the correction for a wrong piano hand
 * split. `<bars>` is `5`, `3-8` or `bar3-bar8`. Only the pitches below (or at and above) the named one move, so a chord
 * that straddles the split point is cut in two.
 */
async function hands(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  if (flags.positional[1] !== 'move') throw new CliError(EXIT.usage, 'usage', 'hands takes move: `sbscore hands move <id> 3-8 --from s1 --to s2`');
  const id = requiredPositional(flags, 2, 'a score id', 'hands move');
  const range = /^(?:bar)?(\d+)(?:-(?:bar)?(\d+))?$/.exec(requiredPositional(flags, 3, 'a bar range like 3-8', 'hands move'));
  if (range === null) throw new CliError(EXIT.usage, 'usage', 'a bar range is 5, 3-8 or bar3-bar8');
  const first = Number(range[1]);
  const last = range[2] === undefined ? first : Number(range[2]);
  const payload: { from: string; to: string; first: number; last: number; below?: string; above?: string } = { from: required(flags, 'from', 'hands move'), to: required(flags, 'to', 'hands move'), first, last };
  const below = flags.options.get('below');
  const above = flags.options.get('above');
  if (below !== undefined) payload.below = below;
  if (above !== undefined) payload.above = above;
  return submit(flags, client, io, json, id, [{ type: 'hand.move', payload } as Operation]);
}

async function rest(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const sub = flags.positional[1] ?? '';
  const id = requiredPositional(flags, 2, 'a score id', `rest ${sub}`);
  const target = qualified(flags, requiredPositional(flags, 3, 'an address', `rest ${sub}`));

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
 * `sbscore chord set <id> <address> --text F#m7b5` and `chord rm <id> <address>` (V5, Q32).
 *
 * The address is a beat within a bar — `bar3.beat1`, `bar3.beat3` — because a chord anchors to a
 * beat, and two chords in one bar are two addresses. `set` is an upsert on the server, so the same
 * verb places the first chord and edits it later. The text is passed through untouched: whether the
 * grammar can read it is the server's business, not the CLI's, so `--text "solo break"` is stored
 * and flagged exactly like a mistyped chord rather than being refused here.
 */
async function chord(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const sub = flags.positional[1] ?? '';
  const id = requiredPositional(flags, 2, 'a score id', `chord ${sub}`);
  const target = requiredPositional(flags, 3, 'an address', `chord ${sub}`);

  if (sub === 'set') {
    const text = required(flags, 'text', 'chord set');
    const payload = { text, ...spellOf(flags) };
    return submit(flags, client, io, json, id, [{ type: 'chord.set', target, payload } as Operation]);
  }
  if (sub === 'rm') {
    return submit(flags, client, io, json, id, [{ type: 'chord.rm', target } as Operation]);
  }
  throw new CliError(EXIT.usage, 'usage', 'chord takes set or rm');
}

/**
 * `sbscore text set <id> bar4.beat1 --text '(unis.)'` and `text rm <id> bar4.beat1` (SIB2-169): a text
 * direction above the staff — a cue, a tempo, "unis.". Like `chord set` it is an upsert at a beat, and
 * the text goes through untouched. `rm` takes the beat or the `annotation-N` id `show` prints. Not
 * `--spell`: free text has no spelling.
 */
async function text(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const sub = flags.positional[1] ?? '';
  const id = requiredPositional(flags, 2, 'a score id', `text ${sub}`);
  const target = requiredPositional(flags, 3, 'an address', `text ${sub}`);

  if (sub === 'set') {
    const payload: { text: string; until?: string | null } = { text: required(flags, 'text', 'text set') };
    // A dashed continuation line to the end of a bar (SIB2-170); an empty --until removes it.
    const until = flags.options.get('until');
    if (until !== undefined) payload.until = until === '' ? null : barTarget(until);
    return submit(flags, client, io, json, id, [{ type: 'text.set', target, payload } as Operation]);
  }
  if (sub === 'rm') {
    return submit(flags, client, io, json, id, [{ type: 'text.rm', target } as Operation]);
  }
  throw new CliError(EXIT.usage, 'usage', 'text takes set or rm');
}

/**
 * `sbscore transpose <id> --to Eb` (V6, ADR-0016). Changes the chart's concert key — a mutation, so
 * it goes through the same versioned write path as any edit and is undoable later. `--to` takes a
 * key in the spelling `sbscore show` prints: `Eb`, `F#m`, `C`. The melody and the chord symbols move
 * together; the server decides the spellings by the destination key (ADR-0017), so the CLI passes
 * only the target and judges nothing about the notes.
 */
async function transpose(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const id = requiredPositional(flags, 1, 'a score id', 'transpose');
  const to = parseKey(required(flags, 'to', 'transpose'));
  return submit(flags, client, io, json, id, [{ type: 'transpose', payload: { to } } as Operation]);
}

/**
 * `--staff 2 --voice 2` is the `s2.v2.` qualifier on a bar address, spelled as flags (ADR-0041 section 2): the
 * server sees the one address form either way. An id (`note-17`) names its own staff and voice, so it takes neither.
 */
function qualified(flags: Flags, address: string): string {
  const staff = optionalNumber(flags, 'staff');
  const voice = optionalNumber(flags, 'voice');
  if (staff === undefined && voice === undefined) return address;
  if (!/^bar\d/.test(address)) {
    throw new CliError(EXIT.usage, 'usage', '--staff and --voice go with a bar address like bar3.n2; an id or a qualified address needs neither');
  }
  return `${staff === undefined ? '' : `s${staff}.`}${voice === undefined ? '' : `v${voice}.`}${address}`;
}

/** A bare number names a bar as `bar12` does (SIB2-189); anything else passes through for the server to judge. */
function barTarget(raw: string): string {
  return /^\d+$/.test(raw) ? `bar${raw}` : raw;
}

/** `--instrument 24` or `--instrument none`: a General MIDI program, or none. The server judges the number. */
function programOf(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'none' || raw === '') return null;
  if (!/^\d+$/.test(raw)) throw new CliError(EXIT.usage, 'usage', `--instrument takes a General MIDI program number or none, not ${JSON.stringify(raw)}`);
  return Number(raw);
}

function signedOf(flags: Flags, name: string): number | undefined {
  const raw = flags.options.get(name);
  if (raw === undefined) return undefined;
  if (!/^-?\d+$/.test(raw)) throw new CliError(EXIT.usage, 'usage', `--${name} takes a whole number, not ${JSON.stringify(raw)}`);
  return Number(raw);
}

/**
 * Parts, staves and voices (ADR-0041 section 2, SIB2-226).
 *
 * `sbscore part add <id> [--name Piano] [--instrument 0] [--transposition -2] [--staff-type percussion] [--clef bass]`,
 * `part rm <id> <p2> [--force]`, `staff add <id> [<p1>] [--type standard|percussion|tab] [--clef bass]`,
 * `staff rm <id> <s2> [--force]`, `voice add <id> [<s2>]`, `voice rm <id> <s2.v2> [--force]`,
 * `clef set <id> <s2|s2.bar5> --clef bass|none` and `instrument set <id> [<p1>] [--name ..] [--instrument ..] [--transposition ..]`.
 * `p2`, `s2` and `s2.v2` are the labels `sbscore show` prints; the stable ids (`part-2`, `staff-2`) work too. A
 * `rm` of something holding music is refused unless `--force` says so.
 */
async function structure(noun: 'part' | 'staff' | 'voice' | 'clef' | 'instrument', flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const sub = flags.positional[1] ?? '';
  const id = requiredPositional(flags, 2, 'a score id', `${noun} ${sub}`);
  const at = flags.positional[3];
  const force = flags.switches.has('force') ? { force: true } : {};
  const op = (type: string, target: string | undefined, payload?: Record<string, unknown>): Operation =>
    ({ type, ...(target === undefined ? {} : { target }), ...(payload === undefined ? {} : { payload }) }) as Operation;
  const named = (what: string): string => requiredPositional(flags, 3, what, `${noun} ${sub}`);

  if (noun === 'part' && sub === 'add') {
    const payload: Record<string, unknown> = {};
    const name = flags.options.get('name');
    if (name !== undefined) payload.name = name;
    const program = programOf(flags.options.get('instrument'));
    if (program !== undefined) payload.instrument = program;
    const transposition = signedOf(flags, 'transposition');
    if (transposition !== undefined) payload.transposition = transposition;
    const staffType = flags.options.get('staff-type');
    if (staffType !== undefined) payload.staffType = staffType;
    const clef = flags.options.get('clef');
    if (clef !== undefined) payload.clef = clef;
    return submit(flags, client, io, json, id, [op('part.add', undefined, payload)]);
  }
  if (noun === 'part' && sub === 'rm') return submit(flags, client, io, json, id, [op('part.rm', named('a part like p2'), force)]);
  if (noun === 'staff' && sub === 'add') {
    const payload: Record<string, unknown> = {};
    const type = flags.options.get('type');
    if (type !== undefined) payload.type = type;
    const clef = flags.options.get('clef');
    if (clef !== undefined) payload.clef = clef;
    return submit(flags, client, io, json, id, [op('staff.add', at, payload)]);
  }
  if (noun === 'staff' && sub === 'rm') return submit(flags, client, io, json, id, [op('staff.rm', named('a staff like s2'), force)]);
  if (noun === 'voice' && sub === 'add') return submit(flags, client, io, json, id, [op('voice.add', at)]);
  if (noun === 'voice' && sub === 'rm') return submit(flags, client, io, json, id, [op('voice.rm', named('a voice like s2.v2'), force)]);
  if (noun === 'clef' && sub === 'set') {
    const clef = required(flags, 'clef', 'clef set');
    return submit(flags, client, io, json, id, [op('clef.set', named('a staff like s2, or a staff bar like s2.bar5'), { clef: clef === 'none' ? null : clef })]);
  }
  if (noun === 'instrument' && sub === 'set') {
    const payload: Record<string, unknown> = {};
    const name = flags.options.get('name');
    if (name !== undefined) payload.name = name;
    const program = programOf(flags.options.get('instrument'));
    if (program !== undefined) payload.instrument = program;
    const transposition = signedOf(flags, 'transposition');
    if (transposition !== undefined) payload.transposition = transposition;
    if (Object.keys(payload).length === 0) {
      throw new CliError(EXIT.usage, 'usage', 'instrument set needs at least one of --name --instrument --transposition');
    }
    return submit(flags, client, io, json, id, [op('instrument.set', at, payload)]);
  }
  throw new CliError(EXIT.usage, 'usage', noun === 'clef' || noun === 'instrument' ? `${noun} takes set` : `${noun} takes add or rm`);
}

/**
 * `sbscore bar add <id> [--after <bar>] [--count N]` and `bar rm <id> <bar>` (SIB2-186). Bars are
 * addressed by number, so an insert or a removal renumbers every later bar (and section start) —
 * the ids stay. `add` with no `--after` appends; `rm` refuses a bar that holds anything.
 */
async function bar(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const sub = flags.positional[1] ?? '';
  const id = requiredPositional(flags, 2, 'a score id', `bar ${sub}`);
  if (sub === 'add') {
    const after = flags.options.get('after');
    const count = optionalNumber(flags, 'count');
    const op = {
      type: 'bar.add',
      ...(after === undefined ? {} : { target: barTarget(after) }),
      ...(count === undefined ? {} : { payload: { count } }),
    } as Operation;
    return submit(flags, client, io, json, id, [op]);
  }
  if (sub === 'rm') {
    const target = barTarget(requiredPositional(flags, 3, 'a bar like 5 or bar5', 'bar rm'));
    return submit(flags, client, io, json, id, [{ type: 'bar.rm', target } as Operation]);
  }
  throw new CliError(EXIT.usage, 'usage', 'bar takes add or rm');
}

/**
 * `sbscore section set <id> <bar> [--letter A] [--name Bridge]` and `section rm <id> <bar>`
 * (V7, ADR-0021). The address is a whole bar — `bar5`, `bar17` — because a section attaches to the
 * bar it begins on, not to a beat within one. `set` is an upsert: the same verb creates the section
 * and later edits its letter or name. Omitting a flag leaves that field as it was; `--letter=` (an
 * empty value) clears it.
 *
 * A section with no letter or name is still a section: its start bar forces a line break in the
 * four-bar grid (ADR-0015). Sections are supported and hand-added, never detected (ADR-0021), which
 * is exactly what this verb is for.
 */
async function section(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const sub = flags.positional[1] ?? '';
  const id = requiredPositional(flags, 2, 'a score id', `section ${sub}`);
  const target = barTarget(requiredPositional(flags, 3, 'a bar like 5 or bar5', `section ${sub}`));

  if (sub === 'set') {
    const payload: SectionSetPayload = {};
    const letter = flags.options.get('letter');
    if (letter !== undefined) payload.letter = letter;
    const name = flags.options.get('name');
    if (name !== undefined) payload.name = name;
    return submit(flags, client, io, json, id, [{ type: 'section.set', target, payload } as Operation]);
  }
  if (sub === 'rm') {
    return submit(flags, client, io, json, id, [{ type: 'section.rm', target } as Operation]);
  }
  throw new CliError(EXIT.usage, 'usage', 'section takes set or rm');
}

/**
 * `sbscore barline set <id> <bar> [--start ...] [--end ...]` (V7, ADR-0021). A bar carries an
 * opening barline and a closing one, and this sets either or both. Barline type is hand-set, never
 * detected (D48). At least one of `--start`/`--end` is required; the server refuses a set that
 * changes nothing.
 */
async function barline(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const sub = flags.positional[1] ?? '';
  if (sub !== 'set') throw new CliError(EXIT.usage, 'usage', 'barline takes set');
  const id = requiredPositional(flags, 2, 'a score id', 'barline set');
  const target = barTarget(requiredPositional(flags, 3, 'a bar like 11 or bar11', 'barline set'));

  const payload: BarlineSetPayload = {};
  const start = flags.options.get('start');
  if (start !== undefined) payload.start = start as NonNullable<BarlineSetPayload['start']>;
  const end = flags.options.get('end');
  if (end !== undefined) payload.end = end as NonNullable<BarlineSetPayload['end']>;
  if (payload.start === undefined && payload.end === undefined) {
    throw new CliError(EXIT.usage, 'usage', 'barline set needs --start or --end');
  }
  return submit(flags, client, io, json, id, [{ type: 'barline.set', target, payload } as Operation]);
}

/**
 * `sbscore repeat set <id> <startBar> <endBar>` (V7, ADR-0021). Sugar over `barline.set`: a
 * `repeat-start` on the first bar and a `repeat-end` on the last, submitted as one batch so the pair
 * is a single undoable unit (ADR-0008). The repeated span is `startBar..endBar` inclusive.
 */
async function repeat(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const sub = flags.positional[1] ?? '';
  if (sub !== 'set') throw new CliError(EXIT.usage, 'usage', 'repeat takes set');
  const id = requiredPositional(flags, 2, 'a score id', 'repeat set');
  const from = barTarget(requiredPositional(flags, 3, 'a start bar like 12 or bar12', 'repeat set'));
  const to = barTarget(requiredPositional(flags, 4, 'an end bar like 19 or bar19', 'repeat set'));

  return submit(flags, client, io, json, id, [
    { type: 'barline.set', target: from, payload: { start: 'repeat-start' } } as Operation,
    { type: 'barline.set', target: to, payload: { end: 'repeat-end' } } as Operation,
  ]);
}

/**
 * `sbscore ending set <id> <bar> --numbers 1[,2] --role ...` and `ending rm <id> <bar>` (V7,
 * ADR-0021). A 1st/2nd-ending bracket is set per bar: a multi-bar ending is one `start`, any
 * `continue` bars, and one `stop`; a one-bar ending is `start-stop`. `--numbers` is the pass numbers
 * the bracket covers, comma-separated.
 */
async function ending(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const sub = flags.positional[1] ?? '';
  const id = requiredPositional(flags, 2, 'a score id', `ending ${sub}`);
  const target = barTarget(requiredPositional(flags, 3, 'a bar like 12 or bar12', `ending ${sub}`));

  if (sub === 'set') {
    const numbers = parseEndingNumbers(required(flags, 'numbers', 'ending set'));
    const role = required(flags, 'role', 'ending set');
    const payload = { numbers, role } as EndingSetPayload;
    return submit(flags, client, io, json, id, [{ type: 'ending.set', target, payload } as Operation]);
  }
  if (sub === 'rm') {
    return submit(flags, client, io, json, id, [{ type: 'ending.rm', target } as Operation]);
  }
  throw new CliError(EXIT.usage, 'usage', 'ending takes set or rm');
}

/** `sbscore fermata set|rm <id> <address>` (SIB2-183): a hold over a note or a rest, by the address `show` prints. */
async function fermata(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const sub = flags.positional[1] ?? '';
  const id = requiredPositional(flags, 2, 'a score id', `fermata ${sub}`);
  const target = qualified(flags, requiredPositional(flags, 3, 'a note or rest address', `fermata ${sub}`));
  if (sub === 'set' || sub === 'rm') {
    return submit(flags, client, io, json, id, [{ type: `fermata.${sub}`, target } as Operation]);
  }
  throw new CliError(EXIT.usage, 'usage', 'fermata takes set or rm');
}

/**
 * `sbscore grace add|rm` (SIB2-185): grace notes before a note. `add` takes the principal note's address and a
 * `--pitch`; `--dur` is the flag value (8, 16 or 32; the server judges it) and `--slash` makes it an acciaccatura.
 * `rm` takes a grace id, or a note address to clear every grace on it.
 */
async function grace(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const sub = flags.positional[1] ?? '';
  const id = requiredPositional(flags, 2, 'a score id', `grace ${sub}`);
  const target = qualified(flags, requiredPositional(flags, 3, sub === 'rm' ? 'a grace id or note address' : 'a note address', `grace ${sub}`));
  if (sub === 'add') {
    const payload: Record<string, unknown> = { pitch: required(flags, 'pitch', 'grace add'), ...accidentalOf(flags) };
    const dur = flags.options.get('dur');
    if (dur !== undefined) payload.value = Number(dur);
    if (flags.switches.has('slash')) payload.slashed = true;
    return submit(flags, client, io, json, id, [{ type: 'grace.add', target, payload } as unknown as Operation]);
  }
  if (sub === 'rm') {
    return submit(flags, client, io, json, id, [{ type: 'grace.rm', target } as Operation]);
  }
  throw new CliError(EXIT.usage, 'usage', 'grace takes add or rm');
}

/**
 * `sbscore tuplet set <id> bar3.beat2 --notes 3 --in 2 --over 3` and `tuplet rm <id> bar3.beat2`
 * (SIB2-166). `--notes` written in the time of `--in` (a triplet is 3 in 2); `--in` defaults to the
 * power of two just below `--notes`, so `--notes 3` is a triplet and `--notes 5` a quintuplet in 4.
 * `--over` is how many items the bracket spans from the address, default `--notes`. The server re-lays
 * the run and judges the ratio; `rm` takes any member's address.
 */
async function tuplet(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const sub = flags.positional[1] ?? '';
  const id = requiredPositional(flags, 2, 'a score id', `tuplet ${sub}`);
  const target = qualified(flags, requiredPositional(flags, 3, 'an address', `tuplet ${sub}`));

  if (sub === 'set') {
    const actual = optionalNumber(flags, 'notes');
    if (actual === undefined) throw new CliError(EXIT.usage, 'usage', 'tuplet set needs --notes, e.g. --notes 3');
    const normal = optionalNumber(flags, 'in') ?? 2 ** Math.floor(Math.log2(Math.max(actual - 1, 1)));
    const count = optionalNumber(flags, 'over') ?? actual;
    return submit(flags, client, io, json, id, [
      { type: 'tuplet.set', target, payload: { actual, normal, count } } as Operation,
    ]);
  }
  if (sub === 'rm') {
    return submit(flags, client, io, json, id, [{ type: 'tuplet.rm', target } as Operation]);
  }
  throw new CliError(EXIT.usage, 'usage', 'tuplet takes set or rm');
}

/**
 * `sbscore slur set <id> <from> <to> [--placement above|below|auto]` and `slur rm <id> <slur-id|from>`
 * (SIB2-167). The two note addresses are the ones `show` prints (`bar1.n2`, `note-7`); a slur may cross
 * bars. `rm` takes the `slur-N` id `show` prints, or the note a single slur starts on. The server judges
 * order and that both are notes.
 */
/**
 * `sbscore ottava set <id> <from> <to> --up|--down` and `ottava rm <id> <ottava-id|from>` (SIB2-184): an 8va
 * (`--up`: written an octave below the sound, line above the staff) or 8vb (`--down`) line over a run of notes.
 * The notes keep their sounding pitch. Same addresses as `slur set`; the server judges order and overlap.
 */
async function ottava(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const sub = flags.positional[1] ?? '';
  const id = requiredPositional(flags, 2, 'a score id', `ottava ${sub}`);
  if (sub === 'set') {
    const target = qualified(flags, requiredPositional(flags, 3, 'the note it starts on', 'ottava set'));
    const to = qualified(flags, requiredPositional(flags, 4, 'the note it ends on', 'ottava set'));
    const up = flags.switches.has('up');
    const down = flags.switches.has('down');
    if (up === down) {
      throw new CliError(EXIT.usage, 'usage', 'ottava set needs exactly one of --up (8va) or --down (8vb)');
    }
    const payload = { to, shift: up ? 'up' : 'down' };
    return submit(flags, client, io, json, id, [{ type: 'ottava.set', target, payload } as Operation]);
  }
  if (sub === 'rm') {
    const target = qualified(flags, requiredPositional(flags, 3, 'an ottava id or the note it starts on', 'ottava rm'));
    return submit(flags, client, io, json, id, [{ type: 'ottava.rm', target } as Operation]);
  }
  throw new CliError(EXIT.usage, 'usage', 'ottava takes set or rm');
}

async function slur(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const sub = flags.positional[1] ?? '';
  const id = requiredPositional(flags, 2, 'a score id', `slur ${sub}`);
  if (sub === 'set') {
    const target = qualified(flags, requiredPositional(flags, 3, 'the note it starts on', 'slur set'));
    const to = qualified(flags, requiredPositional(flags, 4, 'the note it ends on', 'slur set'));
    const placement = flags.options.get('placement');
    const payload = { to, ...(placement === undefined ? {} : { placement }) };
    return submit(flags, client, io, json, id, [{ type: 'slur.set', target, payload } as Operation]);
  }
  if (sub === 'rm') {
    const target = qualified(flags, requiredPositional(flags, 3, 'a slur id or the note it starts on', 'slur rm'));
    return submit(flags, client, io, json, id, [{ type: 'slur.rm', target } as Operation]);
  }
  throw new CliError(EXIT.usage, 'usage', 'slur takes set or rm');
}

/**
 * `sbscore break set <id> <bar> [--join]` and `break rm <id> <bar>` (SIB2-174): override the four-bar
 * grid. `break set <id> bar6` ends the line after bar 6; `--join` on a bar that begins a section lets it
 * share the previous line. The server judges whether a join makes sense.
 */
async function lineBreak(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const sub = flags.positional[1] ?? '';
  const id = requiredPositional(flags, 2, 'a score id', `break ${sub}`);
  const target = barTarget(requiredPositional(flags, 3, 'a bar like 6 or bar6', `break ${sub}`));

  if (sub === 'set') {
    const payload = { kind: flags.switches.has('join') ? 'join' : 'after' } as const;
    return submit(flags, client, io, json, id, [{ type: 'break.set', target, payload } as Operation]);
  }
  if (sub === 'rm') {
    return submit(flags, client, io, json, id, [{ type: 'break.rm', target } as Operation]);
  }
  throw new CliError(EXIT.usage, 'usage', 'break takes set or rm');
}

/**
 * `sbscore nav set <id> <bar> --ds-al-coda` and `nav rm <id> <bar> [--segno]` (SIB2-175): the kind is the flag.
 * Exactly one is needed to set; none on `rm` clears the bar.
 */
async function nav(flags: Flags, client: Client, io: Io, json: boolean): Promise<ExitCode> {
  const sub = flags.positional[1] ?? '';
  const id = requiredPositional(flags, 2, 'a score id', `nav ${sub}`);
  const target = barTarget(requiredPositional(flags, 3, 'a bar like 6 or bar6', `nav ${sub}`));
  const named = NAV_KINDS.filter((kind) => flags.switches.has(kind));

  if (sub === 'set') {
    if (named.length !== 1) {
      throw new CliError(EXIT.usage, 'usage', `nav set needs exactly one of ${NAV_KINDS.map((k) => `--${k}`).join(' ')}`);
    }
    return submit(flags, client, io, json, id, [{ type: 'nav.set', target, payload: { kind: named[0] as NavKind } }]);
  }
  if (sub === 'rm') {
    if (named.length > 1) throw new CliError(EXIT.usage, 'usage', 'nav rm takes at most one mark flag');
    const payload = named.length === 1 ? { kind: named[0] as NavKind } : {};
    return submit(flags, client, io, json, id, [{ type: 'nav.rm', target, payload }]);
  }
  throw new CliError(EXIT.usage, 'usage', 'nav takes set or rm');
}

/** `1` or `1,2` → `[1]` / `[1, 2]`. The server normalises order and duplicates; this only reads. */
function parseEndingNumbers(raw: string): number[] {
  const numbers = raw.split(',').map((piece) => Number(piece.trim()));
  if (numbers.length === 0 || numbers.some((n) => !Number.isInteger(n) || n < 1)) {
    throw new CliError(EXIT.usage, 'usage', '--numbers takes pass numbers like 1 or 1,2');
  }
  return numbers;
}

/**
 * `batch` is the whole of what a document-patch endpoint would have bought, without the
 * whole-document read or the structural risk (ADR-0008). One invalid operation applies none of them.
 */
async function batch(
  flags: Flags,
  client: Client,
  io: Io,
  json: boolean,
  readStdin: () => Promise<string>,
): Promise<ExitCode> {
  const id = requiredPositional(flags, 1, 'a score id', 'batch');
  // `--ops @file` and `--ops -` (stdin) keep a long chart out of argv (SIB2-187).
  const given = required(flags, 'ops', 'batch');
  let raw = given;
  if (given === '-') {
    raw = await readStdin();
  } else if (given.startsWith('@')) {
    try {
      raw = readFileSync(given.slice(1), 'utf8');
    } catch {
      throw new CliError(EXIT.usage, 'usage', `--ops: cannot read ${given.slice(1)}`);
    }
  }
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

/**
 * `undo` and `redo` (V8a, ADR-0003). Shared, because they are one shape: revert the last batch, or
 * bring the last reverted one back, by replay of the op log.
 *
 * The version is resolved exactly the way `submit` resolves it — `--if-version` if pinned, else a
 * read first — so an undo is subject to the same optimistic-concurrency check as an edit and cannot
 * silently revert on top of something that landed since. Undoing at the first operation, or redoing
 * with nothing to bring back, is not an error: the server answers `moved: false` and this prints
 * `nothing to undo`, so a script can loop `undo` to the floor without special-casing the end.
 */
async function move(
  which: 'undo' | 'redo',
  flags: Flags,
  client: Client,
  io: Io,
  json: boolean,
): Promise<ExitCode> {
  const id = requiredPositional(flags, 1, 'a score id', which);
  const pinned = optionalNumber(flags, 'if-version');
  const expected = pinned ?? (await client.read(id)).version;
  const result = which === 'undo' ? await client.undo(id, expected) : await client.redo(id, expected);
  io.out(json ? JSON.stringify(result) : moveLine(which, result));
  return EXIT.ok;
}

function moveLine(which: 'undo' | 'redo', result: UndoWire): string {
  if (!result.moved) return `nothing to ${which}`;
  return `${which === 'undo' ? 'undid' : 'redid'}  version ${result.version}`;
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

/**
 * `--accidental auto|show|hide|paren` (SIB2-182): whether and how the note's accidental is drawn.
 * `paren` (or `parens`) is the stored `parens` display, a cautionary accidental in parentheses. Anything
 * else passes through for the server, which owns the list, to judge.
 */
function accidentalOf(flags: Flags): { accidental?: string } {
  const accidental = flags.options.get('accidental');
  if (accidental === undefined) return {};
  return { accidental: accidental === 'paren' ? 'parens' : accidental };
}

/**
 * `--spell` pins the object's spelling so it survives transposition (ADR-0017); `--unspell` clears
 * the pin. Absent, the pin is left as it was — the server keeps an existing one on an upsert. Both
 * at once is a contradiction, so it is refused rather than silently resolved.
 */
function spellOf(flags: Flags): { spellingPinned?: boolean } {
  const pin = flags.switches.has('spell');
  const unpin = flags.switches.has('unspell');
  if (pin && unpin) {
    throw new CliError(EXIT.usage, 'usage', '--spell and --unspell contradict each other');
  }
  if (pin) return { spellingPinned: true };
  if (unpin) return { spellingPinned: false };
  return {};
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

/** `4=120`, `4.=60`: a beat unit (1, 2, 4 or 8, a dot for dotted) and beats per minute (SIB2-177). */
function parseTempo(spec: string): NonNullable<MetaSetPayload['tempo']> {
  const match = /^(\d+)(\.?)=(\d+)$/.exec(spec.trim());
  if (match === null) {
    throw new CliError(EXIT.usage, 'usage', `${JSON.stringify(spec)} is not a tempo; write 4=120 (4.=60 for a dotted beat)`);
  }
  return { unit: { value: Number(match[1]), dots: match[2] === '.' ? 1 : 0 }, bpm: Number(match[3]) };
}

/** A readable, sortable default id. Only used when `--id` is not given. */
function stamp(): string {
  return new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
