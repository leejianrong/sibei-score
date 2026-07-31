# sibei-score — agent brief

A local-only jazz lead sheet notation app. Read this before touching anything.

**Trust the code over these docs.** Where they disagree, the code is right and this file is
stale — fix it.

## Build status, honestly

**V1, V1b–V1d and V2 are done** (`SLICES.md`). What exists: the score model, the layout
engine, **our own engraver**, the server-side PDF path, the store, the address resolver, the
op log and applier, the `/v1/` API, and **the CLI with the text projection**. What does **not**
exist yet: the browser UI, the chord grammar, transposition, the MusicXML codec, export from
the store, and the whole import pipeline. Do not assume a module is there because a plan
mentions it.

**V3 is next** — joining V1's renderer to V2's store, so the product does something whole for
the first time. It is the first slice since V1d to touch `layout`, so `pnpm proof` matters
again.

**V2 was built in five sub-slices**, the way V1 was cut into V1b–V1d, because one write path is
nine build steps and 13 points. Board cards KAN-468 through KAN-472, under the KAN-410
umbrella:

| | Delivers | State |
|---|---|---|
| V2a | The store, migrations on read, and the suite split | **done** |
| V2b | The address resolver — `bar12.beat3`, `bar12.n3`, `note-17` | **done** |
| V2c | The op log, and the applier as the only writer | **done** |
| V2d | The `/v1/` API, the auth seam, and the Origin check | **done** |
| V2e | The CLI, and the text projection — carries V2's demo | **done** |

Nothing in V2 touched the renderer, so `pnpm proof` was not relevant to any of it — the
committed SVG snapshots never moved. That changes with V3.

**VexFlow is gone.** The V1 gate judged its output good and went the other way anyway,
because jazz typography is this product's differentiator rather than its polish and 4.2.5
was the end of a line 5.x cannot continue server-side (ADR-0030). `packages/engrave` now
draws every glyph the layout contract can emit, in either of two faces, and
`packages/draw` and the `vexflow` dependency have been removed. The reasoning is
`docs/v1-render-gate.md` then `docs/v1b-engraver-spike.md`; the outcome is on ADR-0030.

**Two faces.** `normal` is Bravura, `jazz` is Petaluma — the Real Book look. It is a
render-time argument, not a build-time constant: `pnpm proof --font jazz`, or
`renderScoreToPdf(score, {}, { font: 'jazz' })`.


## Commands

```sh
pnpm install               # pnpm workspace; --frozen-lockfile in CI
pnpm check                 # typecheck every package, then both suite layers. The gate.
pnpm typecheck             # each package under its own strict config
pnpm test                  # vitest, both layers, 518 tests
pnpm test:fast             # the no-infra layer — what the pre-push hook runs
pnpm test:infra            # the layer that needs a real store
pnpm test:watch
pnpm serve                 # run the local API on 127.0.0.1:4321
pnpm sibei <verb>           # the CLI. `pnpm sibei --help` lists every verb
pnpm render:nasty          # out/nasty-chart.pdf — the V1 demo
pnpm render all            # every fixture
pnpm vendor:fonts          # regenerate the vendored font slices (needs network)
pnpm hooks:install         # point git at .githooks (do this once per clone)
```

## Proofing visual output — do this, it is not optional

Engraving defects are visual and the test suite does not catch them. 82 green tests and a
passing snapshot coexisted happily with every beamed note drawing a stray flag *and* a
doubled stem. Someone had to look. **After any change that touches `layout`, `engrave` or
`pdf`, look at the result.**

```sh
pnpm proof                            # every fixture, whole pages
pnpm proof nasty-chart --systems      # every system as its own image
pnpm proof nasty-chart --bar 6        # one bar, zoom chosen for you
pnpm proof nasty-chart --system 2 --census
pnpm proof nasty-chart --pdf          # proof the PDF itself, if a rasteriser is present
pnpm proof nasty-chart --bar 6 --compare    # committed snapshot above, this render below
pnpm proof nasty-chart --bar 6 --font jazz  # the handwritten face
```

`--compare` earns its keep the same way `--census` does. It was built for the V1b gate to
stack VexFlow against the engraver; VexFlow is gone and it kept its job by changing what
it compares — the **committed snapshot** above, **your working tree** below, same crop and
same zoom. Reach for it when a snapshot moves: `--census` tells you *what* changed, this
tells you what it looks like. Between them they have caught a stem pointing the wrong way
on a note sitting on the middle line, a repeat sign doubled under a system's opening
barline, and an ending bracket sitting on top of a chord symbol — none of which any test
had an opinion about.

Crops are named after the music, not pixel coordinates: layout knows where every system
and bar sits, so `--bar 11` is exact and the zoom lands at a readable size on its own.
Each run prints a manifest of what it wrote and what each image shows, so **read those
files** — that is the point of the tool.

`--census` is the highest-value flag. It counts the SVG's elements and diffs them against
the committed snapshot:

```
vf-stem     73  58  -15        <- 15 beamed notes were drawing two stems each
<path>     344 314  -30        <- ...and a flag each on top of that
```

That table is what diagnosed the beaming bug, where the raw snapshot diff said only
"one very long line differs". Reach for it whenever a snapshot moves and you want to know
*what* moved before you accept it.

**Never refresh a snapshot to make a red test green.** Run `--census`, understand the
delta, look at the image, and only then accept it.

Proofing the PDF needs an external rasteriser. None is committed because ADR-0027 keeps
the dependency register permissive and the capable ones are mostly copyleft — a tool you
look at output with is a separate program, not part of the product, but it does not belong
in the lockfile either. Any one of these works, and `pnpm proof --pdf` finds it:

```sh
uv tool install --with pillow pypdfium2   # no root; PDFium, BSD/Apache
sudo apt install poppler-utils            # pdftoppm; GPL
sudo apt install mupdf-tools              # mutool; AGPL
```

With none installed, `--pdf` says so and carries on. Little is lost: the PDF is a
conversion of exactly the SVG geometry and an e2e test pins it to identical bytes, so the
SVG proof stands in for the engraving and only the conversion goes unseen.

The older single-file previewer is still there for ad-hoc use:

```sh
pnpm tsx scripts/preview.ts out/nasty-chart.page1.svg 2
pnpm tsx scripts/preview.ts out/nasty-chart.page1.svg 4 --crop 60,150,900,200
```

Refresh SVG snapshots **deliberately**, never to make a red test go green without reading
the diff first:

```sh
UPDATE_SNAPSHOTS=1 pnpm test
```

## The planning corpus is authoritative

This project was fully planned before any code. Those documents are decisions of record,
not background reading.

| File | Role |
|---|---|
| `PLAN.md` | Scope, requirements R0–R9, mechanisms P1–P21, testing approach, assumed defaults |
| `SLICES.md` | The 14 slices in build order, each with its own test plan |
| `CONTEXT.md` | Glossary and the 62-decision register. **Use these terms exactly.** |
| `docs/adr/` | 29 ADRs — the decisions themselves |
| `QUESTIONS.md` | The Q&A audit trail behind them |

Two rules follow. **Ask before deviating from any ADR.** And **if something in the plan
turns out to be wrong, say so rather than working around it** — a silent workaround
destroys the value of having planned.

## Hard invariants

Breaking one of these breaks a decision of record.

- `model`, `music`, `layout` and `codec` are plain TypeScript: **no framework, no Node
  APIs.** `layout` runs in the browser *and* server-side (ADR-0005, ADR-0022). Enforced by
  the compiler — those packages declare `"types": []` and no DOM lib — and by `tests/arch`.
- **The op applier is the only thing that writes to the store** (ADR-0003). `ScoreWriter` is a
  separate interface for exactly this reason, and only the applier may name it — `tests/arch`
  fails if anything else does, which is what kept it true when the HTTP layer arrived.
- **Nothing outside `packages/api/src/store/sqlite-*.ts` may know SQLite exists** (ADR-0006).
  The port is the whole argument that hosting is a deployment change and not a rewrite.
- **MusicXML is a codec at the edges only**, never the runtime truth (ADR-0004).
- **The adapter never makes layout decisions; `layout` never mentions a renderer**
  (ADR-0014). It is `packages/engrave` now, and the seam is why swapping the renderer
  moved no note on the page (ADR-0030).
- **Metrically invalid bars are stored and flagged, never rejected** (ADR-0013). Nothing in
  the pipeline may repair or refuse a bar.
- Every capability is an **op** with both a CLI verb and a UI control, or it is not built
  (Q79). Parity between the two surfaces is a constraint, not an aspiration.

## Layout

```
packages/
  model      score types, tick arithmetic, pitch, derived metric validity
  layout     score -> engine-independent positions: the four-bar grid
  engrave    layout positions -> glyphs, ours, off a SMuFL font's own metrics
  pdf        server-side render: SVG -> PDF, metadata pinned. No DOM
  api        the server side: the store, the op log and applier, the /v1/ HTTP routes
  cli        the `sibei` binary — an HTTP client of the API, never a second write path
  fixtures   hand-authored scores, including the nasty test chart
tests/
  unit/  integration/  e2e/  arch/     no infra: the `fast` layer
  store/  api/  cli/                   need a real store or socket: the `infra` layer
  snapshots/                           committed .svg files
scripts/     development entry points, not product surface
```

### The layout seam

`layout(score, pageSpec) -> pages -> systems -> bars -> items`.

Layout owns everything **above** the bar: which bars go on which line, where each bar box
sits and how wide it is, how tall a system needs to be, page breaks, the title block, and
which accidental each note draws. The adapter owns engraving **inside** a bar box: stem
direction, beam grouping, accidental stacking, tie curves, **and where in the box each
onset sits** — the contract says so in `packages/layout/src/items.ts`, and this file used to
leave that last one out.

If you find yourself computing a position *above* the bar in an adapter, it belongs in
`layout`. If you find yourself naming a glyph in `layout`, it belongs in the adapter.

`LayoutBar` publishes `prefixWidth` — the room the clef, key and time signature were
allocated — so an adapter knows where a bar's *music* starts rather than guessing. It was
added when there were two adapters and they disagreed. A repeat sign is still the
adapter's to make room for, which is the same gap one size smaller.

### The engraver, and how the fonts get in

`packages/engrave` is framework-free like `layout` and `model`: it emits SVG **markup**
rather than DOM nodes, so it needs no `document` and no jsdom. Keep it that way — a test
deletes `globalThis.document` and renders anyway.

Its metrics are vendored, not derived. `packages/engrave/src/fonts/*.generated.ts` are
generated by `pnpm vendor:fonts` from pinned releases and are **not edited by hand**: 43
glyph outlines plus `engravingDefaults` per face, each cross-checked against a second file
of the same release before it is written. Bravura's outlines come from its own SVG font;
Petaluma ships only OTF, so `opentype.js` reads it — a devDependency that runs at
vendoring time and never ships. Licensing is in `packages/engrave/NOTICE.md` (SIL OFL 1.1
for both).

The rule that follows: **no tuning constants, and no font by name.** A stem's attachment
comes from the notehead's `stemUpSE` anchor, a flag's from its `stemUpNW`, every thickness
from `engravingDefaults` — and all of it through the `MusicFont` passed in, never imported.
A face is the reader's choice per render, because a lead sheet is read in a handwritten
Real Book face as often as an engraved one. If you find yourself nudging a number to make a
glyph look right, the anchor you want probably exists: `font.anchor()` throws for one the
font does not publish rather than returning zero, on purpose.

Within-bar spacing is the adapter's (`spacing.ts`). Two forces: what a duration asks for,
which grows with the *root* of the duration rather than in proportion to it, and what a
note's glyphs need whatever the tempo. Rigid glyph widths come out first and only the slack
is shared by time. A bar that does not fill the meter gets only its share of the slack, so
a short bar looks short rather than being justified into looking correct (ADR-0013).

### Addressing (ADR-0007)

`packages/model/src/address.ts`. Three forms, resolved server-side in one place so both
surfaces get identical semantics *and* identical error messages:

```
bar12.beat3    a beat within a bar. 1-based, fractional (bar12.beat2.5). bar0 is the pickup
bar12.n3       the third item in bar 12, by onset then by insertion order
note-17        a stable id
```

**Onsets only, and the error lists what is there.** A beat that is not an onset is a failure
carrying the bar's real onsets — `bar 12 has no note at beat 3; onsets are 1, 2.5, 4`. Never a
snap to the nearest thing: snapping lets an agent edit the wrong note and never find out. The
error is the feature.

Failures are structured (`AddressFailure`) with `formatAddressFailure` as the only place the
prose lives, because the API maps them to status codes, the CLI maps them to exit codes, and
both must print the same words.

Two entry points, and picking the wrong one is the easy mistake. `resolveAddress` is strict and
is what `set` and `rm` want. `resolvePosition` accepts a beat with nothing on it, because for an
`add` an empty beat is the entire point — and it will happily place a note past the end of the
bar, since ADR-0013 stores an invalid bar rather than refusing one.

**`nK` counts rests as well as notes.** ADR-0007 glosses it "the third note in bar 12", which
leaves open whether a rest takes a slot. It has to: a rest is a first-class object (Q35) and
would otherwise be unreachable by position. The narrower reading is recovered by the `kind`
argument — `resolveAddress(score, 'bar2.n2', 'note')` fails with `bar2.n2 is a rest, not a
note` rather than quietly editing the wrong thing. The text projection labels `nK` the same way,
which it must, because ADR-0009's whole design principle is that the projection prints the
addresses the CLI accepts — and there is a test that walks every printed address back through
the resolver and checks it lands on **the object printed beside it**, not merely that it
resolves.

### The store, and the two things called a version

`packages/api` is the first package allowed to be impure. A score is a JSON document in one
SQLite column with a few listing columns beside it, behind a port (ADR-0006):

```
scores(id, owner, title, composer, key, updated_at, version, doc)
```

`doc` is the truth. `title`, `composer` and `key` are derived from it on every write, so the
library view can draw a list without deserialising every chart and cannot drift from what it
lists. `owner` is always `local` and **every query filters on it anyway** — that is what makes
the hosted transition a change to the auth seam rather than to every statement (R8).

**Two files know SQLite exists**, `store/sqlite-store.ts` and `store/sqlite-schema.ts`, and
`tests/arch/store-seam.test.ts` holds it to exactly those two. The driver is deliberately not
a root dependency either, so a test cannot reach past the port to peer at a column — which is
why the migration tests assert everything through it and are better tests for having had to.

The port comes in halves on purpose. `ScoreReader` is reads and anything may hold one;
`ScoreWriter` is writes and **only the op applier may hold one** (ADR-0003, V2c). Keeping the
capability in its own type is what lets that be wired rather than merely intended.

**Two versionings live here and they are not the same thing.** Confusing them is the trap:

- **The document's** `schemaVersion` (ADR-0028) versions the JSON shape. Forward-only, pure
  function per step, migrated in memory **on read** and written back at the current version. A
  document from a *newer* version than the running code is a hard error, never a best-effort
  read.
- **The score's** `version` is optimistic concurrency (ADR-0003). A write carries the version
  it expects; a stale one is refused along with the current version.

The write-back therefore **must not touch the score's `version`** — a migration is not an
edit, and bumping it would make a plain read look like somebody else's write. That is why
there is a separate SQL statement for it with `version` conspicuously absent from the SET
clause, and no general "update the document" statement that could do it by accident.

The chain is a *parameter* of the store, not an import, so the write-back path is tested
against a synthetic migration while `DOCUMENT_MIGRATIONS` is still empty. Every model change
that alters the document shape owes a migration and a fixture. That is a standing tax and it
is the point.

### The op log, and the one write path

`packages/api/src/ops/`. Every mutation is an operation appended to a per-score log and applied
by a single applier, and **nothing else writes to the store** (ADR-0003). "The UI and the CLI
can never disagree" is structurally true rather than maintained by discipline, and it rests on
three things:

1. There is no second write path — both surfaces are HTTP clients of one API (ADR-0002).
2. The only writes come from the applier. `tests/arch/one-writer.test.ts`.
3. Replaying a log from empty reproduces the stored document exactly. `tests/store/applier.test.ts`.

**`apply.ts` is pure; `applier.ts` persists.** Keep it that way. The pure reducer is
`(score, operation) -> {score, operation, changed}` with no store anywhere in it, and that
separation is the only reason property 3 above can be asserted at all. Anything interesting
belongs in the pure half.

**The log stores the *normalised* operation, not the request.** Every value the applier generated
— an id, a bar list — is written back into the payload before it is logged, and replay prefers
the recorded value. That is what makes replay exact rather than merely likely: it does not depend
on the id policy in force when the operation was first applied.

**Three versions, and they are all different things.** The score's `version` is optimistic
concurrency. The document's `schemaVersion` is its shape (ADR-0028). An operation's `version` is
*its* shape, and old operation shapes must stay readable **forever** rather than being migrated,
because undo replays them — so nothing migrates a payload on the way out of the log, and nothing
ever UPDATEs or DELETEs a log row.

**Batches.** One apply is one version bump and one undoable unit whatever its length. The whole
batch folds before anything is written, and the document write plus every log append happen in
one SQL transaction — so one invalid operation means none of them land (ADR-0008). Both halves
are needed: the fold alone would still let a partial append through.

**ADR-0013 lives here.** A `note.add` that makes a bar overflow is *applied* and the bar flagged
`metrically-invalid`. Nothing in the applier may repair or refuse a bar for its rhythm, and
`meta.set` re-flags every bar because changing the meter changes which bars are valid without
touching a note.

There is one deliberate asymmetry with that. **Read leniently, write strictly:** the resolver
copes with two items sharing an onset, because an imported document may contain one, but
`note.add` refuses to *create* one. Two onsets stacked is a second voice, and single-voice is
load-bearing in the layout engine rather than incidental.

**The verb set is deliberately short** — `score.create`, `meta.set`, `note.add|set|rm`,
`rest.add|rm`. `chord`, `section`, `repeat`, `tie`, `tuplet`, `transpose` and `undo` each belong
to a later slice. Two gaps worth knowing about: a score's bar count is fixed at creation (there
is no `bar.append` until V7 needs one), and deleting a score is *not* an operation — it destroys
the log an entry would live in, so it is a library lifecycle call instead.

### The `/v1/` API, and the boundary

`packages/api/src/http/`. **The highest-value seam in the project** (PLAN.md): both surfaces go
through it, and it is where "the UI and the CLI cannot disagree" is either true or false. Most
behavioural tests belong here from V2 on — `tests/store/api.test.ts` drives a real socket, because
calling a handler directly would skip the guards that are the point.

```
GET    /v1/health
GET    /v1/scores            list, from the extracted columns
POST   /v1/scores            create — a batch whose first op is score.create
GET    /v1/scores/:id        the document, its version, its timestamp
DELETE /v1/scores/:id        library lifecycle, not an operation
POST   /v1/scores/:id/ops    one operation, or a transactional list
```

`/v1/` from the first commit (ADR-0022): breaking changes are allowed inside v1 until the hosted
transition, then it freezes and goes additive-only.

**Plain `node:http`, no framework.** Five routes and a JSON body parser is not a framework's worth
of work, and ADR-0029's guards are worth *writing* rather than configuring — a misconfigured CORS
default is exactly the failure this API cannot afford. Express stays a small change if the surface
grows teeth.

**Status codes carry meaning, and 409 carries a version.** 422 for an address miss or a validation
failure (the request was fine, the content could not be applied); 400 only for a body that was not
readable JSON; **409 with `currentVersion`** for a stale write, which is the thing ADR-0003 is
about. Every error body is `{error: {kind, message, detail}}` where `detail` is the whole structured
failure — an address miss ships the bar's real onsets, so an agent branches on data rather than
parsing prose (ADR-0008).

**`server.ts` is the only file holding the whole store**, and it narrows it immediately: the routes
are typed to see a `ScoreReader` and a `ScoreLibrary` and nothing else. That is how V2c's single
write path survived the arrival of an HTTP layer — a handler cannot reach a write even by mistake,
and `tests/arch` fails if `routes.ts` so much as names `ScoreWriter`.

**Three boundary rules, and they landed before the browser exists on purpose** (ADR-0029 is explicit
that retrofitting them against a working client means loosening something to make it pass):

- **Bind `127.0.0.1`, never `0.0.0.0`.** The host is not a parameter of `listen`, so nobody can pass
  the wrong one — including a compose file, whose default would expose the port on the host network.
- **Validate `Origin` on state-changing requests.** An *absent* Origin is allowed and that is not a
  hole: a browser always sends one cross-origin, including on a form POST, so absence means the
  caller is not a browser page — and the CLI is half the intended users.
- **Validate `Host` on everything.** This goes one step past what the ADR spells out, in the same
  direction: the Origin rule closes drive-by *writes*, but a rebound `GET` would still read the
  library out and a browser sends no Origin on a simple cross-origin GET. Costs nothing, and cannot
  inconvenience a real client, because a real client talks to localhost.

No CORS headers are sent at all, wildcard least of all, and `tests/arch` greps the whole tree for
one. The guards run **before** routing, so an unrouted path is not a way past them.

Logs are JSON per line on stderr and deliberately have **no field a file path or a body could go
in** — ADR-0029's rule for later, kept true now by leaving nowhere to put them. An error logs its
`message`, never its stack or its own fields, because an error out of the store carries the database
path.

### The CLI, and the text projection

`packages/cli`. The CLI is an **HTTP client of the API** (ADR-0002) — never a second write path,
which is the entire point. It holds no store and cannot reach one: with the server stopped, no
verb it offers can change a score, and a test asserts exactly that.

```sh
pnpm serve                                  # or `sibei serve --port N --data PATH`
pnpm sibei new --title "Body and Soul" --key Db --bars 32
pnpm sibei note add <id> bar1.beat1 --pitch Db5 --dur 8
pnpm sibei show <id>                        # the text projection
pnpm sibei --help                           # every verb, the address forms, the exit codes
```

`--json` on every verb, and errors are JSON too when it is set — **flat**, so `currentVersion`
and an address miss's `onsets` are one level down rather than three. **Exit codes are a
contract** (ADR-0008): `0` ok, `1` usage, `2` validation, `3` bad address, `4` stale-version
conflict, `5` not found, `6` no server, `7` refused, `8` already exists. Adding one is fine;
changing what a number means breaks every script anybody wrote. They are tested through a real
subprocess as well as in-process, because a number returned from a function is not the contract
— a number the shell sees is.

`sibei serve` is not in SLICES.md's V2 build plan. It had to exist anyway: V2's demo is "author a
chart entirely from the CLI", and without it there is nothing for the CLI to talk to.

**The projection is a contract** (`packages/model/src/projection.ts`, ADR-0009), not ad-hoc
formatting — agents depend on the format, so it changes deliberately and has its own tests:

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

It is lossy on purpose — confidence, spelling pins, repeats, endings and annotations are not in
it — so `sibei open` (the full structured dump) must stay the thing that carries them.

### Never measure text

**Do not use `measureText` or anything that reaches `getBBox()`.** Only a real browser
implements them, so measuring would place text in one position on screen and another in
print, and ADR-0015 requires those cannot drift. Place text with SVG `text-anchor`
instead (`packages/engrave/src/text.ts`), and size a box from the font size and the
character count rather than from a measurement. `tests/arch` enforces this.

The same rule is why no music glyph is text: every one is a filled `<path>` taken from the
font's own outline, so nothing is embedded, nothing is subsetted, and the PDF bytes are
stable run to run. Keeping that property was a large part of why VexFlow 5 was never an
option (`docs/v1-render-gate.md`).

## Workflow

`main` is protected: **PR-only, CI green before merge, no direct pushes.**

1. Branch per slice off a fresh `main`: `git fetch origin && git switch -c v2/one-write-path origin/main`
2. Build the slice. Match the surrounding style — comment density, naming, and the habit of
   citing the ADR that forced a decision.
3. Run `pnpm check` locally. The pre-push hook does this for you.
4. Open a PR saying what and why, with the test evidence.
5. Land on green.

Keep slices vertical and small, the way `SLICES.md` already cuts them. Do not start a slice
before the one it depends on, and do not do a later slice's work early — if you find you
need to, say so.

### Testing

Follow the test plan in `SLICES.md` for the slice you are on; it is written per slice and it
is specific.

- **The suite is two layers** (`vitest.config.ts`), split by what a test needs in order to run
  rather than by what it is about. `fast` is `unit`, `integration`, `e2e` and `arch` and needs
  nothing installed (1.3s, 386 tests); `infra` is `store`, `api` and `cli`, and needs
  better-sqlite3's native binding, a listening socket, and in one file a real subprocess.
  **The pre-push hook runs `fast` only** — a slow gate gets bypassed and then it protects
  nothing. `pnpm test` and CI run both.
- **A new test directory must join a layer.** `tests/arch/suite-layers.test.ts` reads the
  config and fails if a directory belongs to neither, because the failure mode of a layered
  suite is a directory that silently never runs while the summary says green.
- **Every bug and every flake becomes a test first**, then gets fixed.
- **Prove a new guard by watching it fail.** A guard that has never gone red is a guard you are
  guessing about. Break the thing it protects, check the failure names the right thing, restore
  — and do it from a staged or committed tree, never against uncommitted work.
- The highest-value seam is the HTTP API, because both surfaces go through it (`PLAN.md`).
  Most behavioural tests belong there from V2 on.
- Snapshots catch unintended change. They do not judge whether the engraving looks *good* —
  only a person does that.

## Deliberately not built yet

Not oversights. Each lands with the slice that needs it.

| Gate | When | Why not now |
|---|---|---|
| Containerized test infra | probably never | V2a's answer turned out to be that SQLite needs no container: the `infra` layer runs against `:memory:` and temp files. Revisit only if something arrives that genuinely needs a daemon |
| E2E that boots the stack | V4 | There is no stack to boot |
| Health endpoint, structured logs | **done, V2d** | `GET /v1/health`, and JSON-per-line on stderr |
| Deploy gating | never, as such | Local-only by decision (ADR-0001). V8 ships a container; there is no environment to deploy to |
| Published docs site | undecided | ADRs already carry the "why". Revisit if the CLI reference outgrows a README |
| Linter / formatter | undecided | `tsc` is strict and there is one author. Adding one now means reformatting the whole tree; ask first |
| Jazz chord-symbol typography — `Δ`, `ø`, stacked alterations | V5 | The engraver superscripts a chord's extensions, which is parity. Being *better* needs the chord grammar (ADR-0012) |
| Beams across rests, cross-beat groups | when a fixture needs one | Nothing in the corpus beams across a rest, and inventing the case would mean inventing the convention too |
