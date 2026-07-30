# ADR-0007: Musical position addresses in the CLI, stable IDs in the model

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

An imperative CLI (ADR-0008) has to name the thing it is changing. Stable object
IDs (`note-17`) are unambiguous but unreadable and require a lookup before any
edit. Musical positions (`bar 12, beat 3`) are readable but shift the moment a
duration changes.

The instinct expressed in the interview: *"the CLI should reference by musical
position to make it more readable, but the internal data structure can have a
stable ID."*

## Decision

Both, with different roles. The model carries stable IDs; the CLI addresses by
musical position and also accepts IDs. Three rules make positions safe:

1. **Onsets only.** A position addresses a note onset. A position that is not an
   onset — mid-note, a rest, a tie continuation — is an error whose message lists
   the actual onsets in that bar.
2. **Ordinals alongside beats.** `bar12.n3` ("third note in bar 12") is supported
   as well as `bar12.beat3`. This matters because rhythm is exactly what an import
   gets wrong, so beat positions are least reliable at the moment they are most
   needed.
3. **A pickup is bar 0**, so bar 1 is the first full bar, matching how musicians
   count.

Chord symbols are addressed by beat within the bar (`bar12.beat3`), since two
chords in one bar is routine.

The design principle that makes this work: the text projection (ADR-0009) prints
the addresses the CLI accepts, so an agent never has to guess or construct one.

## Consequences

- Position resolution logic and its ambiguity rules are ours to own and test.
- Strict onset addressing was chosen over snap-to-nearest deliberately: snapping
  lets an agent edit the wrong note and never find out, whereas an error listing
  the real onsets is recoverable. A loud failure beats a silent mis-edit.
- IDs are app-owned and need not survive MusicXML export (ADR-0004).
- Ordinal addressing needs a defined ordering when a bar's rhythm is invalid
  (ADR-0013) — ordering is by onset then by insertion order.
