# ADR-0023: Use oemer as a library, with a vendored fork as the contingency

- Status: Accepted
- Date: 2026-07-30
- Deciders: Jian (via `/plan-new-project`, resume mode)

## Status update, 2026-09-11 — the V9 spike ran. Gate: PROCEED TO V10.

**The coordinates are reachable in-process, as a library, without a fork.** Q71 — the most
load-bearing unverified assumption in the plan — is verified true. The exit condition this
ADR mandated is met, so the contingency (a vendored fork) is **not** taken.

How it was verified. `worker/sibei_omr/spike.py` imports oemer as a library and replicates
its own end-to-end routine (`oemer/ete.py:extract`) up to the point where it registers the
recognised objects in oemer's process-global `layers` registry — `staffs`, `notes`,
`note_groups`, `barlines`, `rests` — then reads them straight back. It stops **before** the
MusicXML build, which is the lossy step that discards coordinates and the reason the CLI is
unusable for us. Every `NoteHead`/`NoteGroup`/`Barline`/`Rest` carries a `.bbox`
`(x1,y1,x2,y2)`; every `Staff` carries `x_left`/`x_right`/`y_upper`/`y_lower`. These are
plain instance attributes reached by import — no private API had to be prised open, so the
fork contingency stays unused. The one friction (`extract` is welded to writing a
`.musicxml` file, with no "run the stages, hand me the objects" seam) was handled by copying
its ~40-line stage sequence into the spike, not by forking.

Evidence. On a rendered `aaba-chart` page (coordinate space 1612×2280 after oemer's
normalise+deskew), the spike dumped 8 systems' worth of staves, 66 noteheads and 42
barlines, **all with pixel coordinates inside the image bounds**, every notehead within ~2
staff-spaces of its nearest staff centre. The dump is committed at
`tests/fixtures/omr/aaba-chart.omr.json` and the V9 test plan's three checks (schema
conformance, in-bounds coordinates, notes within staff extent) run against it in CI as pure
TypeScript — the spike itself needs Python + weights and stays standalone.

CPU wall-clock (the ADR-0025 measurement), single-threaded onnxruntime CPU provider on
this environment's hardware, recognition only (segmentation + extraction, the stages the
spike times):

| Chart (rendered page) | Coordinate space | Detected | CPU wall-clock |
|---|---|---|---|
| aaba-chart | 1612×2280 | 8 systems, 66 noteheads, 42 barlines | **321 s (5.4 min)** |
| nasty-chart | 1612×2280 | 61 noteheads, 25 barlines, 2 rests | **336 s (5.6 min)** |

The figures cluster because oemer normalises every image to ~3.67 MP before recognition, so
wall-clock is driven by that fixed pixel budget, not by chart content or source resolution.
This is a clean rendered chart — the best case, with no skew, shadow or JPEG noise — so it
is a **lower bound**; real photographs will be slower and are V10 evaluation input
(ADR-0020). The image is normalised to ~3.67 MP before recognition, so wall-clock is largely
independent of source resolution; peak RSS was ~7 GB.

Corrections to this ADR's premises, found on contact with the code (the plan describes
intent, not the current package):

- **oemer's last release is 0.1.8 (2024-11-16)**, not "October 2023 / 0.1.7" as the Context
  states. The reasoning here is unaffected — it is still a quiet dependency with a
  fork always available under MIT — but the version to pin is 0.1.8.
- **The inference runtime has to be pinned alongside the weights**, which extends ADR-0024.
  The default dependency `onnxruntime-gpu` is replaced by the CPU wheel (ADR-0025 floor,
  a drop-in), and onnxruntime must be held below ~1.19: newer versions tightened ONNX
  shape-inference and refuse oemer's bundled ConvTranspose nodes. opencv must be held below
  5 (opencv 5 changed `cv2.HoughLinesP`'s return shape, breaking staffline extraction), and
  numpy below 2. The working set is oemer 0.1.8 / onnxruntime 1.16.3 / opencv 4.10 / numpy
  1.26 — recorded in `worker/pyproject.toml`.

Findings booked for V10 (recognition quality and stage-3 interpretation, not reachability):
oemer's `zones` layer covered only the upper part of the page (it ended at y≈1513 while
staves and noteheads ran to y≈2027), so stage 3 should lean on per-staff extents rather than
zones; and the `staffs` layer repeats each system's staff across an 8-slot track grid, which
the consumer must collapse. Neither affects the gate. Full write-up: `worker/README.md`.

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
