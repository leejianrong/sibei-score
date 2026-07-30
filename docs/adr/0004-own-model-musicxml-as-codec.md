# ADR-0004: Our own score model; MusicXML is a codec at the edges

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

`REQS.md` calls for parsing into "a real interchange format rather than something
bespoke," names MusicXML, and separately records the belief that MusicXML "is the
right interchange format even if it turns out to be a poor internal
representation." MusicXML is verbose, and its `<harmony>` element — which is how
chord symbols are expressed — is awkward for the one thing this product cares most
about.

A concern was raised mid-interview that VexFlow, the chosen renderer, cannot read
MusicXML.

## Decision

An internal model designed for this domain is the runtime truth. It is compact,
JSON-serialisable, agent-friendly, and carries what a lead sheet actually needs:
a single melody voice with explicit rests, chord symbols anchored to beats,
sections, repeats, pickup, ties, tuplets, and per-object confidence and review
flags.

MusicXML is a codec used only at the boundary: import (from OMR output) and export
(so charts can leave for other applications). It is never the runtime
representation, and no runtime feature may depend on a MusicXML round-trip
preserving anything.

## Consequences

- The VexFlow/MusicXML objection does not bite. Some model-to-renderer mapping is
  required whatever engine is chosen, so VexFlow not reading MusicXML costs
  nothing. The reverse is the actual trap: Verovio's native MusicXML support is a
  convenience that quietly pulls toward making MusicXML the truth.
- Stable object IDs (ADR-0007) are app-owned and need not survive a MusicXML
  round-trip, which is fortunate because MusicXML has nowhere natural to put them.
- Two codecs to write and maintain, plus their fidelity tests. Round-tripping is
  lossy in both directions and this must be documented rather than pretended away.
- Rejected: **MusicXML as the truth** — nothing to keep in sync, but every edit
  becomes XML surgery, `<harmony>` awkwardness spreads through the codebase, and
  positional addressing becomes the only option.
