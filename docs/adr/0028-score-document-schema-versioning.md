# ADR-0028: Versioned score documents with forward-only migrations

- Status: Accepted
- Date: 2026-07-30
- Deciders: Jian (via `/plan-new-project`, resume mode)

## Context

ADR-0006 stores each score as a JSON document in a SQLite column. That document's shape
will change — v0.1 alone adds sections, repeats and spelling pins as it goes, and v0.2
adds confidence and review flags to objects that did not have them.

Nothing in the decisions of record said how a document written by an older version is
read by a newer one. For a personal tool with a growing library of hand-corrected
charts, silently misreading an old document is the worst available outcome: the data is
irreplaceable and the corruption is quiet.

## Decision

Every score document carries a `schema_version` integer from the first commit.

Migrations are **forward-only** and run on read: a document below the current version is
migrated in memory, used, and written back at the current version. A document from a
*newer* version than the running code is a hard error, not a best-effort read.

Each migration is a pure function from version N to N+1, with a test that carries a real
fixture document through every version to the present.

## Alternatives considered

| Option | Why not |
|--------|---------|
| No version field; infer shape by inspection | Guessing which shape a document is, is exactly the ambiguity a version field removes, and it gets harder with every change. |
| Version the SQLite schema only | The interesting shape is inside the JSON document, which the table schema says nothing about. |
| Migrate the whole store on startup | Slower and riskier than migrating on read, and it makes a rollback destructive. |
| Bidirectional migrations | Doubles the work to support a downgrade nobody has asked for. |

## Consequences

- Retrofitting this later would mean guessing the shape of documents already on disk, so
  the near-zero cost now is the entire argument.
- Every model change that alters the document shape owes a migration and a fixture. This
  is a standing tax on model changes, and it is the point.
- Writing back on read means a plain read can produce a write. That must not bump the
  score's `version` (ADR-0003) or it would spuriously invalidate a client's expected
  version — a migration is not an edit and must not appear in the op log.
- The op log has the same problem: replaying an old log (ADR-0003's undo mechanism)
  requires old operation payloads to remain interpretable. Operations therefore carry
  their own version too, and old operation shapes must stay readable forever rather than
  being migrated away.
