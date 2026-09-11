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

**Against the container** ([Quick start](../README.md#the-container--just-run-the-app) has the
`docker compose up`); point the CLI at its port:

```sh
export SBSCORE_URL=http://127.0.0.1:8080
pnpm sbscore list
```

### Talking to the server

| Flag / env | Meaning |
|---|---|
| `--url <base>` / `SBSCORE_URL` | The API base URL. Defaults to `http://127.0.0.1:4321` (the `pnpm serve` default). |
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
bar address like `bar12`.

## Charts

```sh
sbscore new [--title T] [--composer C] [--key K] [--time 4/4] [--bars N] [--pickup] [--id ID]
sbscore list                                 # every chart: id, title, composer, key, version
sbscore open <id>                            # the full document, as JSON
sbscore show <id>                            # the text projection — a four-bar grid with addresses
sbscore duplicate <id> [--id NEW]            # a copy with a fresh history (ADR-0003)
sbscore rm <id>                              # delete a chart (destroys its op log; asks in the UI)
sbscore meta set <id> [--title T] [--composer C] [--style S] [--key K] [--time 4/4]
```

`show` is the projection an agent reads to learn a chart cheaply; `open` is the raw document.
`new` and `meta set` have no browser control yet (Q79's one knowing exception).

## Notes, rests and chords

```sh
sbscore note add <id> <address> --pitch Eb5 --dur 8 [--spell]
sbscore note set <id> <address> [--pitch Eb5] [--dur 8] [--tie start|stop|both|none] [--spell|--unspell]
sbscore note rm  <id> <address>
sbscore rest add <id> <address> --dur 4
sbscore rest rm  <id> <address>
sbscore chord set <id> <address> --text "F#m7b5" [--spell]      # upsert a chord symbol
sbscore chord rm  <id> <address>
```

Durations are a note value and a dot per dot: `--dur 4`, `--dur 4.` (dotted quarter), `--dur 2..` —
the same spelling `show` prints. `--spell` pins the current enharmonic spelling to the object so a
later transpose leaves it alone (ADR-0017); `--unspell` releases it. Chord text is parsed by the
grammar in `packages/music`; whether the grammar can read it is the server's call, so `--text` takes
whatever you write.

## Transpose, structure

```sh
sbscore transpose <id> --to Eb                                   # change the concert key (ADR-0016)
sbscore section set <id> <bar> [--letter A] [--name Bridge]      # a section boundary (ADR-0021)
sbscore section rm  <id> <bar>
sbscore barline set <id> <bar> [--start none|repeat-start] [--end single|double|final|repeat-end]
sbscore repeat set <id> <startBar> <endBar>                      # a repeat pair around startBar..endBar
sbscore ending set <id> <bar> --numbers 1[,2] --role start|continue|stop|start-stop
sbscore ending rm  <id> <bar>
```

## Undo, redo and batches

```sh
sbscore undo <id>                            # revert the last edit — or the last batch, as one unit
sbscore redo <id>                            # reapply the last undone edit
sbscore batch <id> --ops '[{"type":"note.add", ...}]'           # many operations as one atomic unit
```

Undo and redo replay the append-only op log rather than mutating it (ADR-0003), so a `batch` — and
the browser's multi-edit actions — undoes as a single step. In the browser, ctrl-Z / ctrl-shift-Z.

## Export

```sh
sbscore export <id> [--pdf | --musicxml] [-o PATH]
                    [--paper a4|letter] [--font normal|jazz]
                    [--for bb-trumpet|bb-tenor|eb-alto|eb-bari|f-horn]
```

`--pdf` is the default. `--musicxml` writes MusicXML to open in MuseScore, Finale or Sibelius — it is
a codec at the edges (ADR-0004), lossy in [known ways](../packages/codec), and it ignores `--paper`
and `--font`, which are page choices. `--for` exports a transposing instrument's part (the notes it
reads, transposed). Without `-o` the file is written to the working directory, named after the
chart's title — *Body and Soul* becomes `./Body and Soul.pdf`; `-o` takes a file path, or a directory
to put that name in.

## Concurrency

Every write names the version it expects (ADR-0003). Pass **`--if-version N`** — the version you read
earlier — to pin it: you get exit `4` (a stale-version conflict) if someone moved the chart since,
which is the only way to be sure what you are overwriting. Without the flag the CLI reads the current
version first, so an edit is read-modify-write and never a blind overwrite.

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

## Offline

The CLI and the server it talks to make **no network connection** beyond your own machine — no
telemetry, no account, no cloud. Charts live in a local SQLite library, exports are produced locally.
See [Offline by design](../README.md#offline-by-design).
