# ADR-0013: Store and flag metrically invalid bars; never reject a parse

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

Should every bar's durations sum to the time signature? Import will routinely
produce bars that do not — rhythm is among the hardest things for OMR to get right,
and it is oemer's known weak spot (ADR-0010).

Three options: reject invalid writes; auto-repair before storing; or store the
invalid bar and flag it.

## Decision

Store and flag. Never reject.

A bar whose durations do not sum to the meter is stored as-is and flagged for
review. The UI highlights it; the text projection marks it (ADR-0009); export warns
but does not refuse.

## Consequences

- This is the structural expression of the product's founding assumption: a parse is
  a draft, not a finished import. Rejecting or repairing would force the pipeline to
  guess, and the user would then be correcting the *repair* rather than the parse —
  strictly worse, because a plausible wrong repair is harder to spot than an
  obviously broken bar.
- Metric validity becomes a derived, always-computable property rather than an
  invariant. Every consumer — layout, export, the text projection — must cope with
  an invalid bar.
- The percentage of metrically valid bars is a useful accuracy metric (ADR-0020)
  and, unlike engine confidence, it is reliable and engine-independent.
- Explicit rest objects are required in the model for this to work at all.
- Rejected: **strict validation with a repair stage** — cleaner invariants, but it
  makes repair logic load-bearing and hides the parse's actual failures from the
  person best placed to fix them.
