# ADR-0038: Full notation is the long-term direction; labels are the long-lived asset

- **Status:** Proposed — direction of record, not a schedule. Nothing in it is built.
- **Date:** 2026-10-23
- **Deciders:** Jian, in design discussion
- **Relates to:** [ADR-0031](0031-bespoke-recogniser.md),
  [ADR-0036](0036-real-corpus-labelling-and-dataset-strategy.md),
  [ADR-0021](0021-notation-coverage-boundary.md),
  [ADR-0004](0004-own-model-musicxml-as-codec.md)

## Context

[ADR-0031](0031-bespoke-recogniser.md) made the bespoke recogniser small on purpose: monophonic,
single-staff jazz lead sheets, "the domain narrowness keeps the models small". The card that records
the wish to go further (SIB2-74, "classical / general OMR") was parked with the note that it
"contradicts the narrowness the bespoke recogniser is built on" and becomes an ADR *when the
maintainer decides it is a project*.

The first real pages the labelling studio opened (ADR-0036) show the narrowness is already being
exceeded by ordinary lead-sheet material. *Shaw 'Nuff* p1 opens with a full-band intro: a grand staff,
a bass clef, a drum staff, diamond noteheads, an 8va line and stacked voices, before the single-staff
lead sheet begins at section A. *Wail* has triplet brackets and a three-flat key signature the
vocabulary cannot yet express. The maintainer has now decided the direction: **the long-term goal is
for the bespoke model to detect and classify everything on such a page, and for the editor to cope
with it.**

That is a direction, not a plan, and two things make it easy to get wrong:

1. **Labels outlive models.** A human correction is the one asset here that cannot be regenerated, and
   under ADR-0036's no-retained-pixels rule it is re-attached to pixels only transiently. A label
   scheme that records only what today's vocabulary can express would have to be redone by hand each
   time the vocabulary widens.
2. **Labels alone do not deliver it.** Stage 2a reads one staff as one single-voice token sequence;
   the editor's `Score` is one staff and one voice. Neither can represent a grand staff or two voices
   however well the pages are labelled.

## Decision

**Adopt full notation as the long-term direction, staged, with the lead-sheet path never gated on
it.** Five commitments.

### 1. The direction is of record; the schedule is not

The bespoke recogniser is to grow, one notation family at a time, toward multi-staff, polyphonic,
percussion and spanning notation. This ADR commits to no date and to no particular order beyond the
ordering principle in part 4. SIB2-74 stops being "parked, contradicts the plan" and becomes the
umbrella the notation-coverage epic (E4: SIB2-64…68) sits under.

### 2. ADR-0031's narrowness is a stage, not a ceiling

The v0.3 pipeline (monophonic, single staff, in-vocab) remains the shipping path and the one the
product, the eval harness and the engine-swap decision (V17f) are measured on. Nothing in this ADR
delays it, widens its gate, or changes the default engine. Each widening below is **opt-in until it
wins the harness** (ADR-0020's three dimensions: accuracy, speed, RAM) and lands behind its own ADR.

### 3. Record wide, train narrow

Labels are recorded at the **fidelity a human can supply cheaply**, not the fidelity today's models
can consume: every region gets a `kind` and a completion `status`, and what falls outside the
vocabulary is kept as a positioned **extended tag**, never silently dropped (the schema is ADR-0036's
2026-10-23 amendment). The exporter then *projects* the labels down to what each trained model's
vocabulary can learn, and masks the rest. Widening the vocabulary later is a re-export, not a
re-label.

### 4. Widening order follows the harness, not the wish list

Each step is its own slice with a vocabulary/schema bump, a corpus (synthetic + real) and an ADR when
it changes a contract. A plausible order, easiest and most contained first, **recorded as a hypothesis
to revise on evidence**:

1. ties and triplets/tuplets (SIB2-64; the runtime `Score` already has `Tuplet`);
2. alternate noteheads and articulations (SIB2-66);
3. staff **roles and clefs** — recognising *that* a staff is a drum or bass staff, a Stage-1 change
   that needs only the `kind` labels this ADR requires now;
4. multi-staff / grand-staff grouping;
5. voices on one staff (SIB2-67) — **a different output formulation, not more of the same vocabulary**:
   a single-voice CTC sequence cannot express it, so this is a research step with its own gate and may
   need a different Stage-2a architecture;
6. cross-bar spanners (SIB2-68) and percussion notation.

### 5. The editor's `Score` does not change under this ADR

Recognising a drum staff and *editing* a drum staff are different problems. Until a separate ADR widens
the `Score` model (multi-staff, voices), an import that meets a region it cannot represent keeps it
**visible and unparsed** — an "unrecognised region" shown against its source photo in the review pane,
the way flagged objects already are (ADR-0019) — rather than guessing at a parse. That product behaviour
is named here and **deliberately left undesigned**: it needs its own card and, because it touches
`Score`/the surfaces, its own ADR before any code.

## Consequences

- **The studio's label schema is wider than the training contract on purpose** (ADR-0036 amendment).
  That costs labelling effort per page; the tiering there (region kind is a click, notes are expensive,
  extended tags are optional) keeps throughput the metric, not a page count.
- **Stage-1 gains a reason to classify, not just detect.** `kind` labels on drum/accompaniment staves
  are collected now, so adding detector classes later needs no relabelling.
- **Honest limits:** a few real PDFs cannot train a polyphonic recogniser. Volume per notation family
  is the binding constraint, and may bind before the architecture does. The synthetic generator
  (`packages/synth`) is the other half, and will need to *render* each new family to supply ground
  truth the real corpus cannot.
- **The lead-sheet product keeps its narrow, shippable shape.** Anyone reading ADR-0031's "domain
  narrowness" as permanent should read this ADR next to it.
- **Risk — scope creep dressed as a data format.** The extended-tag namespace is open-ended; it must
  stay a *record* of what was seen, not a half-built notation language. A tag earns a vocabulary entry
  only through a slice in part 4.

## Alternatives considered

| Option | Why not |
|---|---|
| Stay narrow, label only what the vocabulary expresses | Forces a hand re-label of every page each time the vocabulary widens, and trains Stage 1 to treat real staves as background. |
| Declare "general OMR" a project with a schedule now | One pages-worth of evidence cannot order six research steps; the harness has to, and it has not scored any of them. |
| Hand full notation to oemer or another engine | oemer is the fallback ADR-0031 keeps, and costs ~7 GB and ~13 min a page; it does not solve the data ownership or the editor limits either. |
| Widen `Score` to multi-staff/voices first | A large, cross-surface change (ADR-0014/0015, Q79) justified by no importer that can yet fill it. |
