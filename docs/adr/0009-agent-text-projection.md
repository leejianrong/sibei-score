# ADR-0009: A compact agent-facing text projection of the score

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

`REQS.md` requires an agent to be able to do anything a human can. Acting is only
half of that — an agent must first *read* the score to reason about it. The obvious
candidates for a read surface, MusicXML and the raw JSON document, are both
expensive in context and error-prone to reason over. This was wanted emphatically.

## Decision

A compact, lossy, bar-by-bar text projection is a first-class read surface,
alongside the full structured dump. Four-bar rows match the printed layout; chord
symbols carry beat placement; melody is listed per bar with each note's address;
`!` marks objects needing review.

```
Body and Soul — key Db, 4/4, 32 bars
  ! = needs review (low confidence)

 1 |Ebm7      Bb7       |Ebm7  Ab7 |...
   bar1  n1 db5/8  n2 eb5/8  n3 f5/4
   bar2  n1 gb5/2  n2 f5/4 !
   bar3  n1 eb5/4~ n2 eb5/8 (tie)
Address: bar2.n2  or  bar2.beat3
```

The projection prints the addresses the CLI accepts (ADR-0007), so reading it
teaches an agent how to write.

## Consequences

- An agent can grasp harmonic shape and form from a few hundred tokens instead of
  tens of thousands of MusicXML.
- The four-bar grouping preserves the chart shape an LLM (and a human) reads
  structure from — the reason a strictly line-per-bar format was rejected despite
  being easier to parse.
- The format is a contract: agents will depend on it, so it needs stability and its
  own tests, not ad-hoc formatting.
- It is lossy by design. Anything not representable in it must still be reachable
  through the structured dump, and the projection must never be the only way to see
  something.
- Rejected: **chord grid only, melody on request** — cheaper per read, but two
  round trips for the common case of correcting a parse.
