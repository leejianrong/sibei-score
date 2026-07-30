# ADR-0001: Local-first, but shaped for a hosted future

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

`REQS.md` specifies a local-only app: no hosted service, no accounts, no network
dependency at runtime, shipped as a Docker container. During the interview a new
constraint arrived: *"eventually I want to be able to transition this to a web app
(like a service that people can use on the web)."*

Those two pull in opposite directions. Building the hosted service now means
accounts, tenancy, object storage, upload limits, HTTPS, abuse control, and paying
per-parse compute for a CPU-heavy multi-gigabyte OMR pipeline — none of which
reduces the product's dominant risk, which is whether OMR on a phone photo works
well enough to be useful. There is also an asymmetry in exposure: a local tool
where the owner photographs their own book sits very differently from a service
where strangers upload copyrighted sheet music to someone else's server.

But "local now" only costs a rewrite later if specific local-first shortcuts are
taken. The expensive retrofits are known in advance: tenancy into a schema and
every query; job semantics into a UI built around synchronous calls; an HTTP
surface into a design where the CLI had privileged filesystem access.

## Decision

Ship the local Docker app as the MVP, under eight constraints that make hosting a
deployment change rather than a rewrite:

1. The HTTP API is the only writer. No file-watching, no `docker exec`, no
   privileged CLI path (ADR-0002).
2. No host filesystem paths in the API. Scores are opaque IDs; images arrive as
   uploads, PDFs leave as downloads. A mounted host directory is a local
   convenience the CLI may use to read a file before uploading it, never the
   mechanism.
3. The score store sits behind a repository interface (ADR-0006).
4. Every score carries an `owner` field from day one, even though its value is
   always `local`.
5. Authentication is a resolvable seam, not a feature: middleware resolves a
   principal, and in local mode returns `local`. Every endpoint already asks who
   is calling and gets an answer.
6. OMR is a job, not a request — submit, then poll or subscribe.
7. The API process is stateless; all state is in the store. No in-memory score
   cache that assumes a single server.
8. The CLI takes a base URL and an optional token from env/config, defaulting to
   `localhost:8080` with no token.

Explicitly **not** built now: signup, billing, TLS, cloud storage, rate limiting,
multi-user editing of one chart.

`REQS.md`'s "no network dependency at runtime" is reinterpreted as a statement
about the MVP *deployment* — the local container needs no network — not as an
architectural prohibition.

## Consequences

- The MVP costs a little more than the simplest possible local app: a job queue
  and a repository interface that a single-user local tool would not need.
- The hosted transition becomes: swap the store implementation, swap the blob
  store, make the auth seam resolve real principals, deploy. No schema migration
  for tenancy, no UI rework for async imports.
- Copyright exposure is deferred but recorded as a gate on the hosted transition:
  uploads private and account-scoped, no shared chart library, no training corpus
  built from user uploads.
- Alternatives rejected: **hosted from day one** (inflates the MVP on the
  non-risky axis while the risky one is unproven); **local-only, deal with it
  later** (accepts precisely the retrofits listed above).
