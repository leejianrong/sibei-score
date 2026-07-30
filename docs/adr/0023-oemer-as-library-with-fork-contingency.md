# ADR-0023: Use oemer as a library, with a vendored fork as the contingency

- Status: Accepted
- Date: 2026-07-30
- Deciders: Jian (via `/plan-new-project`, resume mode)

## Context

Stage 3 of the import pipeline (ADR-0010) aligns recognised chord bounding boxes to
note and barline **pixel X-coordinates**. Those coordinates are the entire reason
oemer was chosen over Audiveris, which emits MusicXML and therefore has no
coordinates at all.

Verification found this is less settled than assumed. oemer's documentation describes
internal `Staff`, `NoteHead`, `NoteGroup`, `Barline` and `Rest` objects that carry
coordinates and attributes, but does not state that they are a supported public API,
and the command-line entry point emits only MusicXML. oemer's last release is
**October 2023**, so there is no active maintainer to ask for a stable interface.

This is the most load-bearing unverified assumption in the plan: if the coordinates
cannot be reached, stage 3 as designed cannot be built.

## Decision

Import oemer **as a Python library**, not by shelling out to its CLI, and reach the
intermediate objects directly.

Prove this in a **spike that runs before any application code is written** (slice V9).
The spike loads a real photo, runs oemer in-process, and dumps notes and barlines with
their coordinates to JSON. It also measures CPU wall-clock, which ADR-0025 needs.

If the internals turn out to be unreachable or unusable, the contingency is to
**vendor a fork of oemer** — the MIT licence permits it — and expose the objects we
need. Re-deriving coordinates ourselves from oemer's segmentation output is the
fallback of last resort.

## Alternatives considered

| Option | Why not |
|--------|---------|
| Shell out to the oemer CLI and parse its MusicXML | Discards exactly the data stage 3 exists to consume. Coordinates are unrecoverable from MusicXML. |
| Vendor a fork from the start | Takes on maintenance of an OMR codebase before knowing whether it is necessary. |
| Re-derive coordinates from segmentation masks | Substantially more expensive, and duplicates work oemer already does internally. |
| Switch to `homr` | AGPL-3.0, MusicXML-only with no exposed coordinates, and covers only pitch and rhythm. See ADR-0027. |

## Consequences

- The riskiest unknown is confronted in the first slice of v0.2, before anything is
  built on top of it. This is why v0.2 opens with a spike rather than a feature.
- Depending on another project's internals means an oemer upgrade can break us
  silently. Mitigated by pinning the version exactly and by the schema-conformance
  tests on the worker's output.
- Building on a dependency last released in October 2023 is accepted. The MIT licence
  is what makes that acceptable: a vendored fork is always available, which would not
  be true of an AGPL alternative.
- The worker owns this coupling entirely. Nothing outside the worker knows oemer
  exists, so a fork or replacement is contained (ADR-0005).
