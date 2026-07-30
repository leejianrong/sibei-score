# ADR-0006: SQLite, with the score as a JSON document

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

Scores have to live somewhere. Two candidates: a directory of human-visible files
(inspectable, git-diffable, no schema) or a database. The deciding instruction was
explicit — *"go with whatever is easier for us to transition to a web app in the
future."*

A second question sits inside the first: if a database, is a score a JSON document
in one column or normalised note and chord tables?

## Decision

**SQLite**, behind a repository interface (ADR-0001). A score is a **JSON document
in a single column**, with a few columns extracted for listing:

```
scores(id, owner, title, composer, key, updated_at, version, doc JSON)
```

Binary artefacts — source images, exported PDFs — live in a local directory behind
a `BlobStore` interface.

## Consequences

- The hosted transition is direct. SQLite maps onto Postgres nearly 1:1: both
  relational, both transactional, both do row-version optimistic concurrency the
  same way, and `jsonb` accepts the document column unchanged. `BlobStore` gains an
  S3-compatible implementation. Files-on-disk would have mapped onto nothing —
  the database layer would have been written then anyway, plus a migration.
- The library/browse view (`list`, `search`, `open`, `delete`) and transactional
  single-writer semantics come for free.
- A JSON document is already the shape shipped to an agent, so there is no
  object-relational mapping between what is stored and what is served.
- Cross-chart queries ("every tune containing a Db7") are not possible without
  scanning. Accepted: the MVP does not need them, and SQLite JSON functions or a
  derived index can be added later without touching the model.
- Rejected: **normalised note/chord tables** — would mean hand-rolling a mini-ORM
  for musical objects, joins on every read and write, and a harder atomic version
  check, in exchange for the cross-chart queries above. Rejected: **files on disk**
  — git-diffable charts are genuinely appealing, but locking, versioning and
  listing all become ours to build, and none of it survives hosting.
- Some inspectability is lost. MusicXML export (ADR-0004) and the text projection
  (ADR-0009) cover most of what a plain-file layout would have given.
