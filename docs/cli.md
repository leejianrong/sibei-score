# The `sbscore` CLI reference

`sbscore` authors and edits jazz lead sheets from the command line. It is a thin **HTTP client of
the local `/v1/` API** (ADR-0002) — never a second way into the store — so anything it does, the
browser can do too, and the two cannot disagree about a chart. Every edit is an *operation*
addressed by beat or by id.

`sbscore --help` prints the live, authoritative list of verbs, address forms and exit codes; this
page explains them with examples. Where the two differ, the `--help` output (and the code behind it)
is right.

## Running it

There is no globally-installed binary yet; you run the CLI from the repo with `pnpm sbscore <verb>`,
and it talks to a server you start separately.

**From source** (Node ≥ 22 and [pnpm](https://pnpm.io)):

```sh
pnpm install
pnpm serve                       # the API on http://127.0.0.1:4321 — leave it running
pnpm sbscore list                # in another terminal
```

**Against Postgres** instead of the local SQLite file (V19; the hosted deployment's store):

```sh
sbscore serve --database-url postgres://sibei_app:…@host:5432/sibei     # or SBSCORE_DATABASE_URL
```

Connect as an ordinary role that owns its tables — the server refuses a superuser (or `BYPASSRLS`) role,
because row-level security would not apply to it (`--allow-rls-bypass` opts out, for local development
only). `--data` cannot be combined with it. The URL is never printed: the startup line shows only scheme,
host, port and database. Only `SBSCORE_DATABASE_URL` is read, never the generic `DATABASE_URL`, so an
unrelated environment cannot switch your library. `--blobs DIR` (or `SBSCORE_BLOBS`) places the scans and
export cache; by default they sit beside where the SQLite file would be. `pnpm test:postgres` runs the
adapter's tests against a throwaway Postgres.

Blobs can live in an S3-compatible bucket instead (SIB2-136): set `SBSCORE_S3_ENDPOINT`, `SBSCORE_S3_BUCKET`,
`SBSCORE_S3_ACCESS_KEY_ID` and `SBSCORE_S3_SECRET_ACCESS_KEY` together (optional `SBSCORE_S3_REGION`, `_PREFIX`,
and `_PUBLIC_ENDPOINT` for the host clients are signed URLs for). Environment only, so no secret is in argv; the
bucket must already exist. `pnpm test:s3` runs the adapter's tests against a throwaway S3 gateway.

**Against the container** ([Quick start](../README.md#the-container--just-run-the-app) has the
`docker compose up`); point the CLI at its port:

```sh
export SBSCORE_URL=http://127.0.0.1:8080
pnpm sbscore list
```

### Talking to the server

| Flag / env | Meaning |
|---|---|
| `--url <base>` / `SBSCORE_URL` | The API base URL. Defaults to `http://127.0.0.1:4321` (the `pnpm serve` default). A trailing slash is ignored. |
| `--json` | Machine-readable JSON on stdout instead of the human text. On every verb. |
| `--if-version N` | Optimistic concurrency on any verb that writes — see [Concurrency](#concurrency). |

## Addresses (ADR-0007)

Anything you edit inside a chart is named one of three ways:

```
bar12.beat3    a beat within a bar — 1-based, fractional (bar12.beat2.5); bar0 is the pickup
bar12.n3       the third item in bar 12
note-17        a stable id (survives edits)
```

Onsets only: **a beat with nothing on it is an error that lists the bar's real onsets**, never a
snap to the nearest note. `sbscore show <id>` prints the addresses the CLI accepts for a chart, so
you never have to guess one. Whole-bar verbs (`section`, `barline`, `repeat`, `ending`) take a bare
bar like `12` or `bar12`.

## Charts

```sh
sbscore new [--title T] [--composer C] [--key K] [--time 4/4] [--bars N] [--pickup] [--id ID]
sbscore list                                 # every chart: id, title, composer, key, version
sbscore open <id>                            # the full document, as JSON
sbscore check <id> [--json] [--strict]       # list every flagged object: address, kind, reasons (--strict exits 2 if any)
sbscore show <id>                            # the text projection — a four-bar grid with addresses
sbscore duplicate <id> [--id NEW]            # a copy with a fresh history (ADR-0003)
sbscore import <file>...                     # OMR a photo/scan into a new draft chart (ADR-0019)
sbscore import --note-events FILE            # a NoteEvents v1 file (audio engine) into a draft (ADR-0040)
sbscore reparse <id> [--engine oemer|heuristic]  # re-OMR a chart's kept scans into a new draft
sbscore rm <id>                              # delete a chart (destroys its op log; asks in the UI)
sbscore meta set <id> [--title T] [--composer C] [--style S] [--key K] [--time 4/4]
                      [--footer TEXT] [--footer-pages first|last|all]
                      [--signature-policy every|first|page]
                      [--chord-style standard|dash|words|real-book]
                      [--tempo 4=120]
```

`show` is the projection an agent reads to learn a chart cheaply; `open` is the raw document.
`new` and `meta set` have no browser control yet for the title, composer, style, key and meter (Q79's
one knowing exception); the footer has one, in the score view's rail.

`--footer` is a copyright or credit line printed in the bottom margin of the PDF and the browser
sheet, wrapped to fit between the margins (write `\n` for a line break; an empty `--footer ''`
removes it). `--footer-pages` picks `first`, `last` or `all` pages (the default). It is part of the
chart, so it is a logged, undoable edit and shows in `show`; MusicXML carries the text as `<rights>`
but not the page choice.

`--signature-policy` says where the clef and key signature are drawn: `every` system (the default, and what
a chart without the setting does), the `first` system only, or the first system of each `page`. The
time signature is always printed once. Later systems that lose the prefix get the room back, so their bars
widen. Bar numbers stay on each system. It is a logged, undoable edit with a control in the score view's
rail, it shows in `show`, and MusicXML has no home for it.
`--chord-style` chooses how the chart prints its chords, in the PDF and the browser alike (one render
path, so they match byte for byte): `standard` (the default: `Δ7`, `m7`, `ø7`), `dash` (`Δ7`, `-7`,
`-7♭5`), `words` (`maj7`, `min7`, `min7♭5`, `dim`, `aug`) or `real-book` (`MA7`, `MI7`, `MI7♭5`). It is
a rendering choice only: the stored chord text, `show` and MusicXML are unchanged, and MusicXML does not
carry the style. `standard` clears it. It is a logged, undoable edit with a select in the score view's rail.

`--tempo` draws a metronome mark, a small note glyph and a number, above the first bar (after the pickup, if any; `4=120`, `4.=60` for a
dotted beat; units 1, 2, 4 and 8; 20 to 400; an empty `--tempo ''` removes it). It is separate from the free-text
`--style` line, and it is notation only: nothing plays. MusicXML carries it as a `<metronome>` and a
`<sound tempo>` (in quarter notes a minute) on the first measure, and reads it back. It is a logged, undoable
edit, it shows in `show` as `tempo: 4=120`, and the score view's rail has a Tempo control.

`import` needs a server started **with a worker** (`sbscore serve --worker URL`, or the compose
stack); without one it is a 503 and every other feature still works (Q80). It takes several files as
one chart, in page order (Q26), waits for the recogniser (CPU-only recognition is minutes, ADR-0025),
and prints the new chart's id. **Every parse is a draft** (ADR-0019): open it, fix the bars flagged
`!` by `show`, and set the key, meter and sections — import defaults the key to C major and the meter
to 4/4 and never detects sections (ADR-0021), so the four-bar layout is wrong until you add them
(ADR-0015). An image with no staff fails with exit 2 and creates nothing (ADR-0018). The source images
are kept forever (ADR-0019), so a chart can be re-parsed later by a better engine.

`import --note-events FILE` takes the audio engine's **NoteEvents v1** JSON (ADR-0040) instead of an
image, and needs **no worker**. The seconds are quantized to bars (using the file's beat grid if it has
one), the key is guessed, and the result is a draft like any other: notes the transcriber was unsure of
are flagged `!` (with their confidence, `c5/4!41`), and **bar 1 is flagged when the file marks no
downbeats**, because then where the bars start is a guess. The engine's warnings are printed under the
success line and kept on the import record. Voice and bass only (one melody staff, ADR-0021). A file that
is not valid v1, has a `schema_version` other than 1, or names another instrument is refused with
exit 2 and creates nothing. A silent file imports as an empty one-bar draft with its warnings.

`reparse` is that re-parse: it re-runs OMR on the scans an import kept (no new upload — the server
reuses the retained images, V14e) and lands the result as a **new** draft, printing its id; the
original chart and any corrections on it are left untouched. `--engine` picks the recogniser —
`heuristic` on a small host, `oemer` where the RAM is there — and without it the worker keeps its own
default (host-appropriate). Like `import` it needs a server with a worker and waits for the job. A
chart with no scan behind it (hand-authored or duplicated) has nothing to re-run and fails with exit 2. An
import id the server does not know (or an image index past the end) is exit 5, and retrying an import job
that has not failed is exit 2.

```sh
sbscore reparse sc_7f3a --engine oemer      # re-run oemer over the kept scans -> a fresh draft id
```

## Notes, rests and chords

```sh
sbscore note add <id> <address> --pitch Eb5 --dur 8 [--accidental auto|show|hide|paren] [--spell]
sbscore note set <id> <address> [--pitch Eb5] [--dur 8] [--tie start|stop|both|none] [--accidental auto|show|hide|paren] [--spell|--unspell]
sbscore note rm  <id> <address>
sbscore rest add <id> <address> --dur 4
sbscore rest rm  <id> <address>
sbscore chord set <id> <address> --text "F#m7b5" [--spell]      # upsert a chord symbol
sbscore chord rm  <id> <address>
sbscore text set <id> <address> --text "(unis.)"                # a text direction above the staff
sbscore text rm  <id> <address|annotation-id>
sbscore fermata set <id> <address>                               # a fermata over a note or rest
sbscore fermata rm  <id> <address>
sbscore slur set <id> <from> <to> [--placement above|below|auto]  # a slur from one note to a later one
sbscore slur rm  <id> <slur-id|from>
```

Durations are a note value and a dot per dot: `--dur 4`, `--dur 4.` (dotted quarter), `--dur 2..` —
the same spelling `show` prints. `--spell` pins the current enharmonic spelling to the object so a
later transpose leaves it alone (ADR-0017); `--unspell` releases it. Chord text is parsed by the
grammar in `packages/music`; whether the grammar can read it is the server's call, so `--text` takes
whatever you write.

A **text direction** — a cue, a tempo, "unis.", "solo on form" — is free text above the staff at a beat:
`sbscore text set <id> bar4.beat1 --text '(unis.)'`. It is an upsert (one per beat), it prints in the chord
band beside any chord at that beat, and `show` lists it under its bar with the beat and an `annotation-N`
id, which `text rm` takes as well as the beat. MusicXML carries it as `<words>`. In the browser, select a
bar: the Structure panel has a Text directions field.

A **fermata** is a hold sign over a note or a rest: `sbscore fermata set <id> bar4.n2`, `fermata rm` to take it
off (refused where there is none). It draws above the staff and above the note's own ink, centred on the
head, and the chord band rises to clear it. `show` marks it `^` after the duration (`c5/4^`, `r/4^`), and
MusicXML carries `<fermata type="upright"/>` and reads it back. In the browser, select a note or rest and tick
Fermata. It has no playback length. Charts written before fermatas need no migration.

A **slur** runs from one note to a later one, in the same bar or another: `sbscore slur set <id> bar1.n2
bar2.n3`. It is stored as a `spanner` (a kind and the ids of its two notes, so it follows them), setting the
same pair again only changes `--placement` (`auto`, the default, means by stem direction), and removing either
end note removes the slur. `show` lists them as `slur  bar1.n2 -> bar2.n3 slur-1`, and `slur rm` takes that
id or the note a single slur starts on. Both ends must be notes, not rests. MusicXML carries a slur as
`<slur type number placement>` and reads one back. Charts written before slurs have no `spanners` field and
need no migration. Undoable like any edit. A slur draws on the notehead side (above a run of down stems,
below a run of up stems, above when mixed) unless `--placement` chose, rises just enough to clear the notes
and stems under it, stays under the chord band, and splits into two halves where it crosses a line break.
In the browser, select a note, shift-click a second one, and press Add slur in the Selected panel (the same
panel lists and removes a note's slurs).

## Transpose, structure

```sh
sbscore transpose <id> --to Eb                                   # change the concert key (ADR-0016)
sbscore bar add <id> [--after <bar>] [--count N]                 # add empty bars, default at the end
sbscore bar rm  <id> <bar>                                       # remove an empty bar
sbscore section set <id> <bar> [--letter A] [--name Bridge]      # a section boundary (ADR-0021)
sbscore section rm  <id> <bar>
sbscore barline set <id> <bar> [--start none|repeat-start] [--end single|double|final|repeat-end]
sbscore repeat set <id> <startBar> <endBar>                      # a repeat pair around startBar..endBar
sbscore ending set <id> <bar> --numbers 1[,2] --role start|continue|stop|start-stop
sbscore ending rm  <id> <bar>
sbscore tuplet set <id> <address> --notes 3 [--in 2] [--over 3]       # bracket --over items from <address> as --notes in the time of --in
sbscore tuplet rm  <id> <address>
sbscore break set <id> <bar> [--join]                            # end the line after <bar>; --join: a section shares the line
sbscore break rm  <id> <bar>
```

A section's `--letter` and `--name` each draw as a box above the bar the section starts on, the name beside the
letter (`--letter A --name HEAD` draws both; a name alone draws one box). A name that only repeats the letter is
not boxed twice. The PDF and the browser draw the same bytes. MusicXML carries the letter as `<rehearsal>`; the
name has no home there and stays a named lossy case.

`bar add --after bar8` puts new empty bars after bar 8; every later bar's number goes up (and a section
starting there moves with it), while ids stay. `bar rm` refuses a bar that holds notes, chords, text, an
ending or a section start. Both are undoable.

**Tuplets.** Write the notes at their written values, then bracket them: `tuplet set <id> bar3.beat2 --notes 3 --in 2 --over 3`
makes the three items from beat 2 a triplet (3 in the time of 2). The run closes up to its scaled length and later
items in the bar follow, so a bar of one quarter, three eighths and two quarters fills 4/4. `--in` defaults to the power
of two below `--notes`, `--over` to `--notes`. `tuplet rm <id> <any member>` restores the written lengths. One op, so
one undo; nested tuplets are refused. The browser has the same under Selected, on a note or rest.

**Line breaks.** The layout is a four-bar grid with a forced break at each section (ADR-0015). A chart can say
otherwise: `break set <id> bar6` ends the line after bar 6 (the grid carries on from bar 7); `break set <id>
bar3 --join` lets a bar that begins a section share the previous line, which is how an intro and section A
sit on one line; `break rm` returns a bar to the grid. `meta set --bars-per-system N` (1 to 8) changes the
count for the whole chart. With none of these set nothing changes. `show` lists them on a `lines:` line.
MusicXML carries a break as `<print new-system="yes"/>` and reads one back; `--join` and the count have no
MusicXML form. In the browser, click a bar for its line break and use Bars per line in the rail.

## Undo, redo and batches

```sh
sbscore undo <id>                            # revert the last edit — or the last batch, as one unit
sbscore redo <id>                            # reapply the last undone edit
sbscore batch <id> --ops '[{"type":"note.add", ...}]'           # many operations as one atomic unit
sbscore batch <id> --ops @ops.json                              # the same, read from a file
cat ops.json | sbscore batch <id> --ops -                       # or from stdin
```

Undo and redo replay the append-only op log rather than mutating it (ADR-0003), so a `batch` — and
the browser's multi-edit actions — undoes as a single step. In the browser, ctrl-Z / ctrl-shift-Z.

## Export

```sh
sbscore export <id> [--pdf | --musicxml] [-o PATH]
                    [--paper a4|letter] [--font normal|jazz]
                    [--page-numbers[=top-right]] [--page-number-format n|page|of]
                    [--page-number-first yes|no]
                    [--for bb-trumpet|bb-tenor|eb-alto|eb-bari|f-horn]
```

`--pdf` is the default. `--musicxml` writes MusicXML to open in MuseScore, Finale or Sibelius — it is
a codec at the edges (ADR-0004), lossy in [known ways](../packages/codec), and it ignores `--paper`
and `--font`, which are page choices. `--for` exports a transposing instrument's part (the notes it
reads, transposed). Without `-o` the file is written to the working directory, named after the
chart's title — *Body and Soul* becomes `./Body and Soul.pdf`; `-o` takes a file path, or a directory
to put that name in.

`--page-numbers` prints a number on each page of the PDF; it is off by default, so existing output is
unchanged. Bare, it is top-right; name a place with `--page-numbers=bottom-center` (`top` or `bottom`
with `left`, `center` or `right`). `--page-number-format` is `n` (`2`), `page` (`Page 2`) or `of`
(`Page 2 of 3`), and `--page-number-first no` leaves page 1 bare. These are page choices, so MusicXML
ignores them. The browser's Export rail has the same controls.

## Audio

```sh
sbscore audio submit take.wav [--instrument piano]   # uploads, queues, prints the job id
sbscore audio list                                   # your audio jobs, newest first
sbscore audio show <id>                              # status, progress, the reason if it failed, or the draft and its warnings
sbscore audio retry <id>                             # requeue a failed job; refused (exit 2) if its audio was already deleted: upload again
sbscore audio rm <id>                                # delete the job and its audio
```

A recording becomes a job that a separate transcription worker picks up, so `submit` returns at once and the
job waits `queued` until a worker takes it. Nothing else is affected while no worker is running. On a hosted
server the file goes straight to object storage by a presigned URL; locally it goes through the API. The
browser's equivalent is the Audio page (`#/audio`, "Transcribe audio" in the library).

When the worker finishes, the result becomes an editable draft in your library: `audio show` prints
`draft: <id>  (sbscore open <id>)` and any warnings (low-confidence notes, a guessed barring, a duration that
disagrees with the file), and the Audio page's "Open the draft" link goes to it. A recording with no sound gives
an empty one-bar draft with the `silent_input` warning. A result that is not valid NoteEvents fails the job and
is not counted against your audio-seconds.

```sh
sbscore audio usage          # audio-seconds transcribed this month, and the allowance if there is one
```

The operator configures the worker and the allowance in the server's environment, not in code:
`SBSCORE_AUDIO_WORKER_TOKENS` (comma-separated `sbsw_…` credentials for the pulling worker; without it there is
no worker surface and jobs wait), `SBSCORE_AUDIO_LEASE_SECONDS` and `SBSCORE_AUDIO_MAX_ATTEMPTS` (defaults 120
and 3), `SBSCORE_AUDIO_FREE_SECONDS` (what each user may have transcribed per calendar month, UTC; unset means
no cap) and `SBSCORE_AUDIO_PLANS` (`usr_abc=unlimited,usr_def=7200` overrides by user id). At the cap the next
job is refused with `quota-exceeded` and a message that says when the allowance renews. The protocol the audio
worker speaks is "Audio worker protocol v1" in ADR-0034's amendment.

## Concurrency

Every write names the version it expects (ADR-0003). Pass **`--if-version N`** — the version you read
earlier — to pin it: you get exit `4` (a stale-version conflict) if someone moved the chart since,
which is the only way to be sure what you are overwriting. Without the flag the CLI reads the current
version first, so an edit is read-modify-write and never a blind overwrite.

## Signing in to a hosted server

A local server has no accounts and needs none. A **hosted** deployment (ADR-0034) gives each person their own
library, and the CLI signs in to it with an API token it is handed — never a password, a session cookie or a
GitHub token.

```sh
sbscore --url https://sibei.example auth login
#   To sign in to https://sibei.example, open:
#     https://sibei.example/#/device
#   and enter this code:  BCDF-GHJK
#   Waiting for approval (the code expires in 10 minutes)...
```

Open the address in a browser you are already signed in to, enter the code, and choose the token's name and
scopes there. The CLI is handed the token once and keeps it. After that every verb works unchanged against that
server.

To ask for less, pass `--scopes read` (or `read,write`) and `--name ci`: the server puts them in the address it
prints, and the approval page opens with them filled in. They are a request, not a grant: the person approving
can change both, and what they approve is what the token gets.

| Verb | What it does |
|---|---|
| `auth login [--scopes S] [--name N]` | The device flow above. `--json` prints one line for the prompt and one for the result |
| `auth login --token-stdin` | The headless fallback: read a token from stdin, check it against the server, keep it. `--token VALUE` also works, but leaves the token in your shell history and process list |
| `auth status` | Who the server thinks you are, where the credential came from, when it expires. Exit `7` when signed out |
| `auth token` | Prints the token and nothing else, so `$(sbscore auth token)` is a token |
| `auth logout` | Forgets the credential for this server. The token stays valid until you revoke it in the browser |

**Where the credential lives.** `~/.config/sbscore/credentials.json` (`$XDG_CONFIG_HOME` is honoured;
`SBSCORE_CREDENTIALS` names another file), mode `0600` in a `0700` directory, written so it is never wider than
that even briefly. It is filed **per server** and sent only to the server it was issued by, so a mistyped `--url`
cannot receive a token meant for another. The CLI warns on stderr if the file is readable by other users.

**In CI,** set `SBSCORE_TOKEN` instead: it is used in place of the file and wins over it, so a job needs no home
directory. `login`, `status` and every error leave the token out of their output; only `auth token` prints it.

A credential the server refuses (revoked in the browser, or past its 90 days) is exit `7` with a pointer back to
`auth login`; a token limited to `read` that tries a write is exit `7` too.

## MCP, for agents

A hosted server is an MCP server. Point an MCP client at `https://<your-server>/mcp` (Streamable HTTP) and it
discovers the OAuth endpoints itself (`/.well-known/oauth-protected-resource`), registers, sends you to the
browser to approve, and gets a token that works on `/mcp` only: its audience is the MCP endpoint, so it cannot
be used on the API, and a CLI token cannot be used there. You can revoke it under **API tokens**.

For a client that launches a local process (Claude Desktop, an editor), `sbscore mcp` serves the same tools over
stdio, using the credential `sbscore auth login` stored (or `SBSCORE_TOKEN`) and `--url`, like every other verb:

```json
{ "mcpServers": { "sibei": { "command": "sbscore", "args": ["mcp", "--url", "https://sibei.example"] } } }
```

Against a local `sbscore serve` it needs no credential at all. stdout is the protocol and nothing else.

The tools are the same on both: `list_scores`, `read_score` (the text projection, which prints the addresses a
write accepts), `create_score`, `edit_score` (a batch at an `expectedVersion`), `undo`, `redo` and `export_score`
(PDF or MusicXML). A result is the API's own JSON; a failure is the API's own error object, so a stale write
carries `currentVersion` and an address miss lists the bar's real onsets. A read-only token (`mcp:read`, or
`read` for the CLI) is refused a write with `insufficient-scope`.

## Exit codes

A contract — branch on these rather than parsing prose:

| Code | Meaning |
|---|---|
| `0` | ok |
| `1` | usage error |
| `2` | validation error (the request was fine, the content could not be applied) |
| `3` | bad address (lists the bar's real onsets) |
| `4` | stale-version conflict (`--if-version` lost) |
| `5` | not found |
| `6` | no server reachable |
| `7` | refused (a guard rejected it) |
| `8` | already exists |
| `9` | rate limited or over quota (back off and retry later) |

## Offline

The CLI and the server it talks to make **no network connection** beyond your own machine — no
telemetry, no account, no cloud. Charts live in a local SQLite library, exports are produced locally.
See [Offline by design](../README.md#offline-by-design).
