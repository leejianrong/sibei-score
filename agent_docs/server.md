# The server side: store, op log, export, API, change stream

`packages/api` is the first package allowed to be impure. This is the store, the one write path,
the export/render path, the `/v1/` routes, and the change bus.

## The store, and the two things called a version

A score is a JSON document in one SQLite column with a few listing columns beside it, behind a
port (ADR-0006):

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

## The op log, and the one write path

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
`rest.add|rm`, `chord.set|rm` (V5), `transpose` (V6), and the V7 structure verbs `section.set|rm`,
`barline.set`, `ending.set|rm`. `tie`, `tuplet` and `undo` each still belong to a later slice. The
structure verbs all target a **whole-bar address** (`bar5`): `section.set` and `ending.set` are
upserts, the same upsert-at-a-place shape as `chord.set`; `barline.set` sets a bar's opening and/or
closing barline. There is no `repeat` op — a repeat is a `repeat-start`/`repeat-end` pair of
`barline.set`s, which the CLI's `repeat set` batches into one undoable unit. Two gaps worth knowing
about: a score's bar count is fixed at creation (there is no `bar.append` yet), and deleting a score
is *not* an operation — it destroys the log an entry would live in, so it is a library lifecycle call
instead.

## Export, the blob port, and the cache that has no invalidation logic

`packages/api/src/blob/` and `packages/api/src/export/` (V3a). This is where the product first
does something whole: a chart authored through the CLI comes out as a printable page.

**`packages/api` holds the render path so nothing else has to.** A `ScoreReader` on one side,
`@sibei/pdf` on the other, and `layout`, `engrave` and `pdf` staying pure behind it. Nothing in
the export path decides anything about the page; it hands a `Score` to the renderer (ADR-0014).

**The blob port has `get` and `put` and deliberately no `delete`.** Q81's cache invalidates
implicitly through the key, so there is no invalidation logic — and offering a delete would be
offering somewhere to write some. `tests/arch/blob-seam.test.ts` holds filesystem knowledge to
`blob/directory-blob-store.ts` alone, the sibling of the SQLite seam. It is scoped to
`packages/api` on purpose: SQLite may be named nowhere in the tree, but a path is a legitimate
CLI argument and `scripts/` is not product surface.

**The port is async where the store is sync**, and that asymmetry is deliberate. `ScoreReader`
is sync because SQLite is, and that debt is already booked; the blob backend worth swapping to
is across a network, so a port that could not express waiting would be rewritten the day it was
used for its purpose.

**The cache key, and why it is longer than Q81 says.** Q81 fixes it at
`(score version, format, instrument)`. It is now:

```
export:<id>:v<n>:<digest16>:<instrument>:<paper>:<font>:<format>
```

One rule covers all three additions: **anything that changes the bytes is in the key.** A key
naming fewer things than the render depends on hands somebody a Letter request and an A4 page
and never tells them.

- **The digest closes a hole in Q81 as written.** Deleting a score destroys its log, and
  `score.create` takes a *client-supplied* id — so a new chart under a reused id starts again at
  version 1, and id-plus-version is not unique over time. Without something naming the document,
  the second chart is served the first one's PDF. Found by a test, not by reading. It adds no
  invalidation: it makes the key name the exact bytes it stands for, and a serialisation change
  would cost a miss, never wrong bytes.
- **Paper and font are amendments for the reason `instrument` was in early.** Q81 predates
  ADR-0030, which makes the face the reader's choice *per render*; Q38 makes the paper one.
  Leaving a component out until something varies it makes that slice a cache-key migration.

**The supported lists are derived, never restated** — `Object.keys(PAPER_SIZES)` and
`MUSIC_FONT_NAMES`. A list an error message quotes has to be the list the renderer can honour,
which is the same principle as ADR-0009's legend being built from a real object in the score.
That is why `packages/api` depends on `@sibei/layout` and `@sibei/engrave`.

**An export is a read.** It cannot reach a `ScoreWriter`, and it must never bump the score's
`version` — a generated artefact is not an edit, the same distinction ADR-0028's migration
write-back turns on.

## The `/v1/` API, and the boundary

`packages/api/src/http/`. **The highest-value seam in the project** (PLAN.md): both surfaces go
through it, and it is where "the UI and the CLI cannot disagree" is either true or false. Most
behavioural tests belong here from V2 on — `tests/api/api.test.ts` drives a real socket, because
calling a handler directly would skip the guards that are the point.

```
GET    /v1/health
GET    /v1/scores            list, from the extracted columns
POST   /v1/scores            create — a batch whose first op is score.create
GET    /v1/scores/:id        the document, its version, its timestamp
DELETE /v1/scores/:id        library lifecycle, not an operation
POST   /v1/scores/:id/ops    one operation, or a transactional list
GET    /v1/scores/:id/export ?format=pdf&paper=a4|letter&font=normal|jazz&instrument=concert
GET    /v1/scores/:id/events SSE: this score's changes (V4a)
```

Every export parameter is optional and defaulted, and an unrecognised value is a **422 carrying
the supported list** — never a silent fallback, which would hand somebody the wrong page and
never say so.

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

Plain `node:http`, no framework. Five routes and a JSON body parser is not a framework's worth of
work, and ADR-0029's guards are worth *writing* rather than configuring. `/v1/` from the first
commit (ADR-0022): breaking changes are allowed inside v1 until the hosted transition, then it
freezes and goes additive-only.

## The change stream, and the payload that is deliberately not the change

`packages/api/src/events/` and `http/event-stream.ts` (V4a). An in-process bus, fanned out over
SSE, so an open score view repaints when something *else* edited the chart.

**The bus comes in `ChangePublisher` / `ChangeSubscriber` halves**, for the reason the store port
does: `server.ts` holds both and hands the routes the subscriber alone, so a handler cannot
announce a change any more than it can make one. And **the applier is *wrapped*, not plumbed
into** — `publishingApplier(applier, publisher)` — which is why `applier.ts` is untouched and
`one-writer.test.ts` still measures exactly what it measured before. A bus the writer had to hold
would be a second reason for something to hold a `ScoreWriter`.

**An event carries `{scoreId, version}` and nothing else.** `changed[]` exists on the applier's
result and was deliberately left out: a client cannot repaint from a list of ids because it does
not hold the new *content*, so it could never save the re-read — it could only invite a client to
treat the stream as truth and be silently wrong forever after one missed event. So the contract is
"this version exists now", and recovery is "re-read if that is not what I hold", which is
idempotent and survives a missed event, a duplicate and a reconnection without any of them being a
special case.

**There is no replay, and the first frame is why that is safe.** No `id:` is emitted on any frame,
because emitting one makes a browser send `Last-Event-ID` and a server that ignores it has made a
promise it does not keep. Instead the stream **opens with a `changed` event carrying the current
version**, so connecting *is* the catch-up and a reconnecting client cannot forget to re-read. That
also leaves KAN-510 free to decide the op log's read shape rather than freezing one here.

**A deletion is an event too** (`event: deleted`), published from a wrapper around `ScoreLibrary`.
Not an op and it cannot be — deleting a score destroys the log an entry would live in — but it is
as much an external change as an edit, and without it a browser holding a deleted chart waits
forever.

**`Api.close()` had to learn about streams.** `server.close()` waits for open connections and an
SSE stream never finishes, so closing a server with one open hung forever. `closeAll()` ends what
this module opened — not `closeAllConnections()`, which would also cut an unrelated in-flight
request.

**Why `checkOrigin` lets this GET past, and why that is not a hole.** The Origin guard fires on
state-changing methods only (ADR-0029), and an `EventSource` GET is not one — so a hostile page
*can* open this connection, because its `Host` is `127.0.0.1`, which is exactly what `checkHost`
wants to see. It **cannot read a byte**, because no CORS headers are sent at all and the browser
therefore refuses to hand the stream to the page. **That is a guard working by omission**, and the
whole mechanism is one header nobody wrote — which is precisely the kind of thing somebody later
"fixes" into a hole. A test pins it and `tests/arch` greps the tree for the header. Do not add one.
What is *not* closed is a page holding connections open; that is resource exhaustion rather than
ADR-0029's threat model, and it is booked as a cap (KAN-601) rather than paid for by widening the
Origin rule.
