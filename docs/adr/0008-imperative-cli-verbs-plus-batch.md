# ADR-0008: Imperative CLI verbs plus a batch wrapper; no document patch

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

`REQS.md` requires import, edit, transpose and export to be reachable from the CLI
and usable by an agent with no human in the loop. Two shapes were compared: an
imperative verb surface (`sibei note set bar12.n3 --pitch Bb4`), or a
read-modify-submit patch flow where the agent fetches the document and submits a
modified version.

The comparison that settled it:

| | Imperative verbs | Document patch |
|---|---|---|
| Context cost per edit | One small command; no read needed if the address is known | Must read the whole document first |
| Failure granularity | Per-edit, specific: *"bar 12 has no note at beat 3; onsets are 1, 2.5, 4"* | One accept/reject |
| Structural risk | Server constructs the change; the agent cannot mangle the shape | An LLM regenerating a document drops or mangles fields |
| Atomicity | Not atomic across edits | Naturally transactional |
| Concurrency | Per-edit version check, cheap retry | A stale read wastes the whole patch |
| Surface to build | ~15 verbs to design, document, keep stable | One endpoint |
| Undo | Free — each op is a record | Coarse whole-document snapshots |

## Decision

Imperative verbs as the primary surface, plus a `batch` verb that applies a list of
the same operations in one transaction. No document-patch endpoint in the MVP.

Every command supports `--json` for structured output, and exit codes are distinct
enough to branch on without parsing prose — separate codes for stale-version
conflict, invalid address, and validation failure.

## Consequences

- The `batch` wrapper buys back atomicity, which was the only real advantage patch
  had, without accepting the whole-document read cost or the structural risk.
- The operation log (ADR-0003) falls out of this naturally and becomes the spine of
  the system, serving undo, concurrency and the "never disagree" tests.
- ~15 verbs must be designed, documented and kept stable — and because the CLI's
  contract is the public API in the hosted future, "stable" means versioned from
  the start.
- Agents get precise, actionable errors instead of "your patch is invalid", which
  is the difference between an agent that self-corrects and one that retries blind.
