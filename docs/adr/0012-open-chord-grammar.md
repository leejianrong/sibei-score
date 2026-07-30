# ADR-0012: An open chord grammar that parses to structure

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

Chord symbols are, per `REQS.md`, semantically different from notes and need their
own affordances. Two shapes were available: a closed set of qualities the UI offers
from a menu, or an open grammar that parses arbitrary text into structure.

ADR-0011 raised the stakes: the grammar is also the OCR error-correction mechanism.

## Decision

An open grammar parsing chord text into structure — root, quality, extensions,
alterations, and bass note. It must handle the real jazz vocabulary: `Cmaj7`,
`F#m7b5`, `C7alt`, `Bb13#11`, `Ab/Eb`, `N.C.`

Text the grammar cannot parse is **kept verbatim and flagged**, never rejected and
never silently dropped.

## Consequences

- One implementation serves three jobs: correcting OCR output by snapping to the
  nearest legal symbol, validating what a user or agent types, and driving
  transposition of chord roots (ADR-0016) — which needs the root parsed out
  structurally, not as text.
- Parsed structure is what makes transposition and enharmonic respelling
  (ADR-0017) possible at all. A free-text chord field could not be transposed.
- Keeping unparseable text verbatim means a strange but meaningful marking survives
  an import round trip instead of vanishing. The user sees it flagged and decides.
- A grammar is more work than an enum, and it will need extending as symbols
  surface that it does not cover. Its test suite is a living list of real-world
  chord spellings.
- Rejected: **a closed enum** — cleaner invariants, but it forces the import path to
  discard anything outside the set, and jazz chord spelling has too long a tail.
