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
