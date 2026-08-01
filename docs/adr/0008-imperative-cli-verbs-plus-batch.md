# ADR-0008: Imperative CLI verbs plus a batch wrapper; no document patch

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Status note, 2026-08-01 — the binary is `sbscore`

**The decision stands unchanged; only the program's name moved.** `sibei` collided with an
unrelated product of the same author, `sibei-flow`, which had already settled the convention:
its console script is `sbflow`, its worker package is `sbflow_worker/`, its config is
`~/.config/sbflow/`. So `sb<product>` is a family convention rather than an abbreviation
invented for this repo, and it applies to everything user-facing while the repo keeps its
`sibei-score` name — exactly parallel to `sibei-flow` shipping `sbflow`.

What changed: the `bin` name, `SIBEI_URL` -> `SBSCORE_URL`, `SIBEI_DATA` -> `SBSCORE_DATA`, the
help text and error prose, and the default data directory `~/.local/share/sibei` ->
`.../sbscore` (KAN-599).

What did **not** change, and this is the part that matters here: **no verb and no exit code.**
`0 ok · 1 usage · 2 validation · 3 bad address · 4 stale-version conflict · 5 not found ·
6 no server · 7 refused · 8 already exists` mean what they meant, `batch` is still the
transactional wrapper, and `--json` is still on everything. The Consequences below say "stable
means versioned from the start"; a rename that touched a number or a verb would have broken that,
and none was touched.

The example in the Context below reads `sibei note set …`. It is left as written, because this
ADR is a dated record of what was decided on 2026-07-30 and editing the prose so it reads
`sbscore` would make the record claim a name that did not exist yet. Read `sibei` as `sbscore`
throughout this file and in ADR-0015, ADR-0018 and ADR-0026, which mention the old name in their
reasoning for the same reason.

The **data directory** is the one part of the rename with a mechanism rather than a substitution,
because renaming it blind orphans a live library with no error and no warning — the failure shape
ADR-0028 exists to keep out of this store. A pre-rename directory is **moved into place once**,
whole, when the old path exists and the new one does not: forward-only and deterministic, the
same shape as ADR-0028's migrate-on-read, with a visible line on `serve`'s output. It never
overwrites an existing new-path library. `packages/cli/src/serve.ts` carries the reasoning and
`tests/cli/data-path.test.ts` the four cases.

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
