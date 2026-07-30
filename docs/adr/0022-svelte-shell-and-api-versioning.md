# ADR-0022: Svelte for the UI shell, and `/v1/` from the first commit

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

Two loose ends, both consequences of earlier decisions rather than independent
choices.

**Framework.** `REQS.md` said "React or Svelte with Vite (either is fine, the choice
can fall out of whichever rendering library we settle on)." It does not fall out:
VexFlow is framework-agnostic (ADR-0014), and the score surface is SVG emitted by our
own layout engine (ADR-0015), so the framework does none of the hard work. An
argument was initially offered that React's greater representation in agent training
data mattered because agents are half the intended users — that was **withdrawn as
invalid**: agents reach the product through the CLI and API and never touch the
frontend framework.

**Versioning.** Two decisions pull against each other. The product is a personal tool
(`QUESTIONS.md` Q18), which needs no API stability guarantees. But the CLI's contract
*is* the public API in the hosted future (Q49), which argues for versioning from the
start.

## Decision

**Svelte 5 with Vite** for the UI shell. The component surface it has to cover is
small — shell, split-pane for the side-by-side correction view, file upload, metadata
forms, library table, review flags — and Svelte carries less ceremony for that.

This is made low-risk by an invariant the architecture already requires: **the model,
layout engine, chord grammar and operations are plain framework-free TypeScript.** The
framework touches only the shell. Swapping it later would mean rewriting panels, not
the application.

**`/v1/` in the API path from the first commit.** Breaking changes are permitted
inside v1 until the hosted transition; at that point v1 freezes and becomes
additive-only.

## Consequences

- The remaining tiebreaker for React was that Claude writes more idiomatic React than
  Svelte 5, whose runes are recent. That is an argument about the author rather than
  the product, and it was not decisive.
- The framework-free-core invariant is now load-bearing and worth asserting in tests:
  no import from the model, layout, grammar or ops packages may reach a framework
  package. Without that guard the invariant erodes quietly.
- Versioning the path costs essentially nothing now and avoids retrofitting a prefix
  onto a shipped CLI, which is the kind of change that breaks every script anyone
  wrote.
- Permitting breaking changes inside v1 is honest about the current phase. It does
  mean any agent scripts written before the hosted transition may need updating, which
  is acceptable while the only author and only user is the same person.
