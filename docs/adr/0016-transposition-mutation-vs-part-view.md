# ADR-0016: Concert-key transposition mutates; instrument parts are views

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** Jian (interview via `/grill-with-docs`)

## Context

`REQS.md` asks for transposition of "the whole chart, melody and chord symbols
moving together". The interview surfaced that two different features hide behind
that phrase: changing the concert key of a chart, and producing a Bb-trumpet or
Eb-alto part from a concert lead sheet. Both are wanted.

They look similar and are not. Changing the concert key changes the tune. Producing
a part changes only how the same sounding music is written down for a particular
instrument.

## Decision

The score always stores **concert (sounding) pitch**.

- `transpose --to Eb` is a **mutation**. It changes the chart, goes through the
  operation log, and is undoable like any other edit.
- `export --for bb-trumpet` is a **render-time view**. Nothing is stored. Chord
  symbols transpose along with the written pitch, so a Bb part of a tune in concert
  C shows D7 where the concert chart shows C7.

Supported parts, with correct octave handling: bb-trumpet (M2 up), bb-tenor (M9 up),
eb-alto (M6 up), eb-bari (M13 up), f-horn (P5 up). A part changes written octave and
key signature, not merely pitch class.

## Consequences

- One truth per chart. Had parts been stored variants, every chart would have N
  copies free to drift apart, and an edit would have to be propagated or the copies
  invalidated.
- The model needs no concert-vs-written flag, because the answer is always concert.
  The transposition interval lives with the instrument definition, not the score.
- Both operations share the pitch and chord-root transposition machinery and the
  enharmonic spelling rules (ADR-0017).
- Getting written octave right matters: tenor sax is written a major *ninth* above
  concert, not a major second, and treating the interval as pitch-class-only would
  put the part in the wrong octave — a mistake a player notices immediately.
- Transposing a part requires chord symbols parsed to structure (ADR-0012); root
  text alone could not be moved.
