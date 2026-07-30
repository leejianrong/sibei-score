# ADR-0026: Ship in two milestones — v0.1 without import

- Status: Accepted
- Date: 2026-07-30
- Deciders: Jian (via `/plan-new-project`, resume mode)

## Context

`REQS.md` presents import as one of three pillars, alongside the browser UI and the
CLI, which suggests shipping them together. But `REQS.md` also names import as "the
riskiest part of the whole product", and verification has since added two more unknowns
to it: whether oemer's coordinates are reachable at all (ADR-0023) and how slow a
CPU-only parse is (ADR-0025).

Sequencing everything behind the riskiest component means nothing is demonstrable until
that component works, and a disappointing OMR result means no release at all.

## Decision

Two milestones.

**v0.1 — the app without import.** Create a blank chart, edit notes, rests, chords, key
and time signature, sections and repeats; transpose; generate instrument parts; export
PDF and MusicXML; browse a library; undo; full CLI parity with the text projection. A
complete and useful product that depends on none of the OMR work.

**v0.2 — import.** The worker, the job pipeline, the OMR stages, the correction
experience and the evaluation harness, landing on a foundation already proven by use.

## Alternatives considered

| Option | Why not |
|--------|---------|
| One milestone, everything together | Truest to `REQS.md`'s framing, but the riskiest component gates the entire release and nothing is demonstrable until it works. |
| Split, with the spikes pulled into v0.1 | Buys earlier certainty about v0.2 feasibility, at the cost of v0.1 time. Judged not worth it: the spikes are cheap and can open v0.2 immediately. |
| Import first, editing second | Import produces a draft nobody can correct without the editor, so this ordering delivers nothing usable at any point. |

## Consequences

- If OMR disappoints, v0.1 has still shipped a working notation app. This is the main
  point of the split.
- v0.2's import lands on an editor, a renderer, a store and an op log that are already
  exercised — so import bugs are distinguishable from foundation bugs, which they would
  not be if everything arrived at once.
- The `sibei new` blank-chart path (Q28) stops being a hedge and becomes v0.1's entry
  point. It was already required for CLI parity.
- Requires that the app be genuinely useful without its headline feature. For a
  notation editor that is true; it would not be for a product whose only purpose was
  conversion.
- Some v0.1 work is shaped by v0.2 needs and cannot be deferred — notably confidence
  and review flags on model objects (ADR-0019), which v0.1 never sets but the model must
  carry from the start to avoid a schema migration.
