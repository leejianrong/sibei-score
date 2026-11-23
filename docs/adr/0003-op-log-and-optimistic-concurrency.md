# ADR-0003: The operation log is the spine, with expected-version concurrency

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

Four requirements turned out to want the same mechanism. Concurrent writes from an
agent and a human need a conflict policy. Undo needs a history. "The UI and CLI can
never disagree" needs to be *testable*, not merely asserted. And an imperative CLI
(ADR-0008) produces a natural stream of discrete changes.

## Decision

Every mutation is an operation appended to a per-score op log, applied by a single
op applier. Nothing else writes to the store.

Concurrency is optimistic: every write carries the version the client expects. A
stale write is rejected along with the current version so the client can re-read
and retry. No locks and no last-write-wins.

An **import is itself one operation**, carrying the whole parsed document. Score
creation therefore lives inside the log rather than beside it, which is what keeps
replay-from-empty true as a property.

Undo replays the log minus the last operation. Only forward operations are stored;
there are no inverse operations. Undo walks the log backwards. It is shared history regardless of who made the edit,
so a human can undo an agent's work. A `batch` (ADR-0008) is one undoable unit;
individual operations undo individually.

## Consequences

- "Never disagree" gets three concrete tests: the CLI is an HTTP client of the same
  API as the UI so no second write path exists; a test asserts the only writes to
  the store come from the op applier; and a property test asserts that replaying a
  score's log from empty reproduces the stored document exactly.
- Every feature must express itself as an operation. A change that cannot be
  written as one is a design smell worth catching early.
- Undo, audit trail and conflict handling come from one mechanism instead of three.
- Undo is O(n) in log length, since it replays. Accepted: documents are kilobytes
  and logs are short. Inverse operations were rejected because each of ~15 verbs
  would need a provably correct inverse, and a subtly wrong inverse corrupts state
  silently — no error, just a score that is quietly wrong. Replay cannot be subtly
  wrong; it is either right or it fails loudly.
- Undoing an import leaves an empty score rather than deleting it. Acceptable and
  arguably clearer than making undo destroy an object.
- The log grows. For a personal tool with small documents this is not a concern;
  compaction can be added later without changing the model.
- Rejected: **last-write-wins** (silently destroys the other party's edit — much
  worse when the other party is an agent working unattended); **locks** (a stuck
  lock in a local single-user tool is pure downside); **snapshot undo** (coarser,
  no audit trail, storage grows faster).

## Amendment (SIB2-282): grouping a burst of batches into one undoable unit

**Context.** The log's undoable unit is the `batch` (above), and keyboard note input (SIB2-155) writes one batch per key,
so entering a phrase of eight notes took eight ctrl-Z. A person means "undo what I just typed", not "undo one keystroke".
The unit cannot be widened after the fact by editing rows (the log is append-only and undo-by-replay depends on it), and
the `batch` column is assigned by the store when a write commits, before anyone knows a burst has ended.

**Decision.** A third *control* operation joins `undo` and `redo`: `{ type: 'group', count: n }`, "the last `n` batches in
effect are now one unit". It is a marker like the other two: its own batch of one, stored in the existing `type`/`payload`
columns (no schema change), changing no document content.

- `resolveLog` folds it: it pops the last `n` entries of the applied stack and pushes their operations back as **one**
  entry, in order. Undo then pops the whole burst onto the redo stack and redo brings it back whole, with no other change
  to the walk. A log with no `group` marker resolves exactly as before, so **old logs replay unchanged**, and an agent
  `batch` is still one batch and still undoes as one unit (grouping only ever merges *whole* batches).
- `n` is at least 2 and at most the number of applied batches **below the `score.create` floor**: grouping never absorbs
  the create, so undo still stops at an empty score and not before it. Anything else is a `validation` error.
- It is a write like any other: it carries `expectedVersion`, so it is refused (409) if anything landed after the client's
  last write. That is what makes the count safe: a client groups only a **contiguous run of its own writes** (the version
  advanced by exactly one per write, and the last version is the one it names), so another writer's batch is never
  swallowed. A client that sees the version jump just stops counting at the jump.
- The marker bumps the version (every committed log row does) but the document is unchanged, so replay needs no recompute.
- `redo` after a grouped undo restores the group; a fresh edit after the undo discards it exactly as it discards any redo.

**Who groups.** The surface that knows a burst ended. The browser ends a note-input burst when the mode is left, after a
pause of two seconds without a key, or just before an undo asked for inside the mode, and sends one `group` for the
batches that burst wrote. It is on the API (`POST /v1/scores/:id/group`) and the CLI (`sbscore group <id> <count>`), so the
capability has a verb on both surfaces (Q79) and an agent can group its own run of edits the same way.

**Rejected.** *A `group` tag on each batch*, written at commit: needs a column on both stores' op logs and the client to
know it is starting a burst; *client-only undo-n-times*: the next person to open the chart (or the CLI's `undo`) still
undoes one keystroke, and redo needs the same count remembered; *merging adjacent batches by time*: guesses, and an
agent's interleaved edits are exactly what it must not merge.

**Consequence.** An older build reading a log with a `group` marker does not know the type and fails loudly at replay
(ADR-0028 is the policy for a log newer than its reader); nothing is silently wrong.
