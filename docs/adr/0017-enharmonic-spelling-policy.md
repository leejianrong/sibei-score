# ADR-0017: Key-signature-driven enharmonic spelling with a per-object override

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

Transposition has to choose spellings. The same pitch is Bb or A#, and the same
chord is Ab7 or G#7. A reader expects one and is jarred by the other. There is no
single correct answer derivable from pitch alone — it depends on key context and,
for chromatic material, on harmonic function.

## Decision

Spelling follows the **destination key signature** by default. In Eb major: Bb and
Ab, never A# or G#. Chord roots are respelled by the same rule.

Any note or chord may additionally be **pinned to a preferred spelling**, which
survives transposition.

## Consequences

- The rule handles the overwhelming majority of cases correctly and needs no user
  input, which is what makes transposition a one-command operation.
- The override is the escape hatch for the cases the rule gets wrong — chromatic
  passing chords and secondary dominants, where function argues for a spelling the
  key signature does not suggest. Without it, the app would sometimes produce a
  chart a musician would want to correct by hand and could not.
- Cost: a spelling field on notes and chords, plus defined behaviour for how a
  pinned spelling transposes. The chosen semantics is that a pin expresses intent
  relative to the pitch, so it moves with the note and remains pinned.
- The CLI needs a `--spell` flag on note and chord operations, and the UI an
  affordance for it. Both are small.
