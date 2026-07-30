# ADR-0002: The server owns the score; the HTTP API is the only writer

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

`REQS.md` requires two equal ways into the same score — a browser UI and a CLI
usable by an agent with no human in the loop — and states that "the two must never
be able to disagree about the state of the score."

Three designs were considered: a score file on disk that the CLI edits and the UI
watches; one binary with two entry points, the CLI reaching the score via
`docker exec`; and a server that owns the score with both clients mutating it
through an HTTP API.

## Decision

The server owns the score. The UI and the CLI are both clients of the same local
HTTP API, and it is the only thing that writes. The CLI is a host-side binary
talking HTTP to the exposed port.

The UI holds no private authoritative state — no unsaved local buffer that could
diverge. Edits are submitted as operations and the server broadcasts the result so
other clients repaint.

## Consequences

- "Never disagree" becomes structurally true rather than maintained by discipline:
  there is no second write path that could drift. What remains possible is a
  *conflict*, which ADR-0003's version check turns into a retry.
- The CLI needs an HTTP client and error handling for a server that might not be
  running — more than a file-editing CLI would need.
- Rejected: **file-on-disk as the truth** — inspectable and git-diffable, but two
  writers means real conflict resolution, a UI that must reload mid-edit, and
  nothing that survives hosting. Rejected: **`docker exec`** — awkward to script,
  requires Docker on the caller's machine, and meaningless once hosted.
- The inspectability lost by not using plain files is partly bought back by the
  agent-facing text projection (ADR-0009) and MusicXML export (ADR-0005).
