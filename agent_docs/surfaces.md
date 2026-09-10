# The two surfaces: the CLI and the browser

Both are HTTP clients of `/v1/` (ADR-0002). Neither holds a store, an applier, or a render path
beyond what it needs to draw. They cannot disagree because there is one API behind them.

## The CLI, and the text projection

`packages/cli`. The CLI is an **HTTP client of the API** — never a second write path, which is
the entire point. It holds no store and cannot reach one: with the server stopped, no verb it
offers can change a score, and a test asserts exactly that.

```sh
pnpm serve                                  # or `sbscore serve --port N --data PATH`
pnpm sbscore new --title "Body and Soul" --key Db --bars 32
pnpm sbscore note add <id> bar1.beat1 --pitch Db5 --dur 8
pnpm sbscore show <id>                      # the text projection
pnpm sbscore export <id> -o out/            # the PDF. --paper, --font, -o a file or a directory
pnpm sbscore --help                         # every verb, the address forms, the exit codes
```

`sbscore serve` hands the API a **directory blob store beside the sqlite file**, so the export
cache survives a restart rather than living in a process-lifetime `Map`.

**The binary was `sibei` until 2026-08-01** (KAN-599, CONTEXT.md D67, and a status note on
ADR-0008). It collided with an unrelated product of the same author, `sibei-flow`, which had
already settled the convention: `sbflow`, `sbflow_worker/`, `~/.config/sbflow/`. So `sb<product>`
is a family convention rather than an abbreviation invented here, and the repo keeps its
`sibei-score` name — exactly parallel. **No verb and no exit code changed**, which is the part that
mattered: those are the contract (ADR-0008), and the name is not. The env vars are `SBSCORE_URL`
and `SBSCORE_DATA`; the ADRs still say `sibei` in their bodies and that is correct, because a dated
decision records what was decided.

The library lives at `${XDG_DATA_HOME:-~/.local/share}/sbscore/scores.db`, with the blob cache
beside it. **A pre-rename library at the old path is adopted once**, by moving the whole directory,
and only when the default path is in use — `--data` and `SBSCORE_DATA` name a path on purpose.
Renaming the default without that would have orphaned a live library *silently*: the new path does
not exist, so a fresh empty database appears beside a full one and nothing says so. It moves the
directory in one `rename` rather than file by file because that is **atomic and cannot
half-complete**, and because it carries SQLite's `-wal` and `-shm` sidecars, which hold committed
data under WAL mode. A failed move raises rather than falling through to a fresh database.

**`sbscore export` renders nothing.** It is an HTTP client like every other verb and holds no
renderer — `tests/cli/no-second-render-path.test.ts` fails if `packages/cli` so much as imports
`@sibei/pdf`, `@sibei/layout` or `@sibei/engrave`. One render path, the same way there is one
write path.

**A filename off a socket is not a path.** The server sanitises the download name at source
because it goes in a `Content-Disposition` header and its stem is the chart's title — and the
CLI re-derives it anyway, because "the server already checked" is what makes a client the weak
half of a pair, and the CLI is the half that turns a name into a write. Two layers: an allowlist
strictly narrower than anything the server can emit (so it never rejects a legitimate name), and
a containment assertion against the directory the caller chose. The allowlist is free; the
assertion states the property, so a later change to the allowlist cannot quietly stop enforcing
it.

`--json` on every verb, and errors are JSON too when it is set — **flat**, so `currentVersion`
and an address miss's `onsets` are one level down rather than three. **Exit codes are a
contract** (ADR-0008): `0` ok, `1` usage, `2` validation, `3` bad address, `4` stale-version
conflict, `5` not found, `6` no server, `7` refused, `8` already exists. Adding one is fine;
changing what a number means breaks every script anybody wrote. They are tested through a real
subprocess as well as in-process, because a number returned from a function is not the contract
— a number the shell sees is.

Every `unsupported-<parameter>` the export route can answer with maps to `2`, **matched by
prefix** rather than a case per parameter, so a parameter added server-side lands on validation
rather than silently on usage.

`sbscore serve` is not in SLICES.md's V2 build plan. It had to exist anyway: V2's demo is "author a
chart entirely from the CLI", and without it there is nothing for the CLI to talk to.

### The projection is a contract

`packages/model/src/projection.ts`, ADR-0009 — not ad-hoc formatting. Agents depend on the format,
so it changes deliberately and has its own tests:

```
Body and Soul — Johnny Green — key Db, 4/4, 8 bars — Ballad
  ! = needs review · 1 bar does not fill the meter

 1 |Ebm7  Ab7|         |         |         |
   bar1   n1 db5/8  n2 eb5/8  n3 f5/4  n4 gb5/2
   bar2!  n1 f5/4~  n2 r/4
 5 |         |         |         |         |

Address: bar1.n2  or  bar1.beat1.5  or  note-2
Onsets only: a beat with nothing on it is an error listing the bar's real onsets.
```

Four-bar rows, matching the printed layout — a line-per-bar format parses more easily and was
rejected anyway, because the four-bar grouping is what a reader takes structure from. `~` marks a
tie on the side it points; `(3)` a triplet member; `r` a rest; `!` anything flagged. Empty bars
print no melody line, so a blank 32-bar chart stays under 700 characters — R2 is that an agent
can read a chart *cheaply*.

**It prints the addresses the CLI accepts, and the legend is built from a real object in the
score.** That is the design principle the whole addressing scheme rests on: reading the
projection is how an agent learns to write one. The `nK` labels here and `resolveAddress`
therefore have to agree about everything, rests included.

**The review line is `reviewSummary(score)` in `packages/model/src/review.ts`, not a template
literal inside the projection** (V4b). It moved out because the browser's score rail shows review
state in the projection's own words, and two surfaces phrasing the same fact separately is the
thing this architecture exists to prevent — a test asserts the projection's line *is* the summary's
sentence. It also means KAN-597 (a blank chart reporting every bar as under-filled) is a one-file
change rather than a hunt.

The worked example above is checked, and it needed to be: the code printed `1 bar do not fill the
meter` for a single bar, while this file's example already documented `does not`. **The doc was
right and the code was wrong** — the less common direction, and nothing pinned the singular until
V4b did. A deliberate change to an ADR-0009 contract, which is the only way that contract may
change.

It is lossy on purpose — confidence, spelling pins, repeats, endings and annotations are not in
it — so `sbscore open` (the full structured dump) must stay the thing that carries them.

## The browser

`packages/ui`. Svelte 5 + Vite (ADR-0022). A library view with search, and a score view that
**opens a chart, edits a note or rest (V4c), and repaints when something else edits it (V4d)**. It
is an HTTP client of `/v1/` exactly like the CLI — it holds no store, no applier and no renderer
beyond `layout` + `engrave`.

**Live updates are an `EventSource`, and the browser decides nothing on the wire** (`lib/events.ts`,
V4d). `watchScore` opens `GET /v1/scores/:id/events` and forwards a `changed` frame's version and a
`deleted` frame; `ScoreView`'s `$effect` opens exactly one stream per mounted chart and re-reads
only when the version it is told about is not the one on screen — the same recovery a stale save
does, because the server's payload is `{version}` and nothing else (`server.md`). A change the
browser made itself, the stream's opening catch-up frame, and a frame mid-save are all no-ops. The
whole path is proved end-to-end by `tests/browser/`, which boots `serve` + `vite` + a real Chromium.

**It composes `layout()` + `engravePage()` itself, in six lines.** It does not call
`renderScoreToSvg`, even though that function is pure and is precisely the composition it wants:
`@sibei/pdf`'s only export entry re-exports `pdf.ts`, so importing it drags **pdfkit** and a
`Buffer` into a browser bundle. Moving the pure half somewhere framework-free was considered and
declined — a subpath export would make the "no `@sibei/pdf`" guard a *nuanced* answer instead of a
flat no, and a guard you have to qualify is a guard that erodes. What holds the two together
instead is an integration test asserting the UI's SVG is **byte-identical** to
`renderScoreToSvg`'s across every fixture × paper × face.

**The design came before the code, and that is the rule for UI work here.** Phase 1 is a
self-contained HTML mockup published for approval — built around *real* engraver output, inlined,
because a mockup of a notation app that fakes the notation cannot be judged. Phase 2 implements it
and checks real screenshots against it. Three things the mockup found by looking, which no brief
would have specified: page 1 of the nasty chart is ~40% white below the last system and **that
whitespace is information** (it is where the chart stops on the page, so nothing crops it); an
under-filled bar and a correct one **render identically**, so review state has to live in the
chrome or it is invisible; and `GET /v1/scores` carries six fields and no review state, which is
why the library is a list and not a gallery with badges.

**The dev server proxies `/v1/`** so the UI is same-origin, which is what ADR-0029's guards
require. `strictPort` is deliberate — it refuses an occupied port rather than sliding to the next
one, because a silent port change is the kind of lie this repo dislikes.

**`tsc -p` cannot read a `.svelte` file**, so this is the one package whose `typecheck` entry is
`svelte-check`. It runs inside the existing `typecheck` job. Do not assume the root script is
uniformly `tsc` — and note that `tests/arch/framework-free.test.ts` sweeps `.svelte` as well as
`.ts` for the same reason: a guard on the UI reading only its `.ts` would be checking the quiet
half of the package.
