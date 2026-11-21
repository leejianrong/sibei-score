# ADR-0037: Song identification via chord-progression retrieval, advisory only

- **Status:** Proposed — planning of record for v0.5 (KAN-1522). Not yet built.
- **Date:** 2026-09-19
- **Deciders:** Jian, in design discussion
- **Relates to:** [ADR-0011](0011-staged-chord-recognition.md),
  [ADR-0019](0019-parse-is-a-draft.md),
  [ADR-0031](0031-bespoke-recogniser.md),
  [ADR-0036](0036-real-corpus-labelling-and-dataset-strategy.md)

## Context

The real corpus ADR-0036 builds is not just training material — it is hundreds of pages of *specific,
identifiable songs*, unlike every synthetic chart the project has generated so far (a synthetic chart
is plausible, not a real tune). That makes a genuinely new capability possible: given a fresh upload,
recognise *which song it already is*, and use that either to short-circuit recognition (hand back the
known chart directly) or to correct recognition (constrain a noisy prediction against the matched
song's known chords/melody). Goal 3 of KAN-1522. Nothing in `docs/omr-pipeline.md` accounts for this
today — it is a new stage, not a refinement of an existing one.

Two things make the design choice here narrower than it looks:

- **Chords are the more reliable signal today, notes are not.** `mapOmrToScore` + the V5 grammar
  corrector already normalise chord text to canonical structure (ADR-0011) — `CM7` and `Cmaj7` compare
  equal — and even the *weakest* current chord path (heuristic + PaddleOCR) scores non-trivially on the
  harness, while note-level accuracy on real photos is exactly the gap this whole initiative exists to
  close (V12/V14f/KAN-1426/KAN-1487/KAN-1512). A matching signal should lean on the more trustworthy
  half of the recognised document, not the half currently under repair.
- **A jazz standard's chord progression is far more stable across arrangements than its melody.** The
  same tune played from two different real books can differ in melodic ornamentation, octave, or even
  which chorus is written out, but the changes are recognisably "the same tune" — the reason musicians
  themselves identify a standard by its changes as often as by its head. Melody is the *harder*
  recognition problem and the *less* stable identifier; chords are the *easier* recognition problem and
  the *more* stable identifier. Both push the same direction.

## Decision

**The matching signal is a transposition-invariant chord-progression fingerprint, queried as an
advisory post-hoc stage after Stage 3, gated by confidence, and never applied without an explicit human
accept.**

1. **Signal: chord-progression fingerprint, primary; melodic contour, deferred.** From a chord
   sequence in bar/onset order (the same traversal `packages/synth/src/labels.ts`'s `chordSequence`
   already uses for the synthetic case, generalised to a small runtime function since this now runs
   against real imports, not the synth tool — it lives in `@sibei/model` or a small new
   `@sibei/retrieval`, never `@sibei/synth`, which is build-time-only by ADR-0031's own exception), each
   chord's root is re-expressed relative to the progression's own tonal centre (its first chord, or its
   most frequent root — transposition-invariant by construction, so the same standard played in a
   different key still matches), quality/extension text kept as canonicalised by the V5 grammar. The
   result is shingled into overlapping n-grams (e.g. 8 chords), the retrieval unit. Melodic interval
   sequence is a plausible secondary signal (also transposition-invariant, by scale-degree or
   semitone-delta rather than absolute pitch) but is **deferred**: today's note-level recognition error
   rate on real photos would inject noise into exactly the signal meant to *correct* noise, so it is
   revisited once ADR-0036's retrained models close more of that gap, not before.
2. **Where it sits: after Stage 3, before human correction — a new, independent stage, not a
   modification of any existing one.** `mapOmrToScore` and the beat-mapped chord sequence are unchanged;
   matching reads their output and writes nothing back into them. This keeps the engine boundary
   (ADR-0005/ADR-0031) intact — matching depends on *what the recogniser produced*, not on which
   recogniser produced it, so it works identically whichever engine is the default.
3. **Confidence-gated, advisory only — never a silent substitution.** Above a stated threshold, the
   import's review surface gains a "possible match: `<title>`, confidence `X`%" affordance offering the
   known chart's chords (and, later, melody) as something to accept, chord by chord or wholesale — not
   an automatic overwrite. This is the same discipline ADR-0019 already established for confidence flags
   ("flag, don't guess silently") applied to a new kind of doubt. Below threshold, or with no index
   available, import behaves exactly as it does today: **the same graceful-degradation contract already
   proven for a missing chord-recognition model pair** (`chords.load_chords`'s empty-band fallback) and
   for a missing worker entirely (Q80) — an absent or inconclusive capability must never make an
   existing one worse.
4. **Accepting a match is an ordinary batch of ops, not a bypass.** Applying a suggested chord or note
   correction goes through the existing op log (`chord.set`/`note.set` in a `batch`, ADR-0003), so undo,
   versioning, and the CLI/UI parity guarantee (Q79) all cover it automatically. There is no new write
   path.
5. **Every capability is an op with both a CLI verb and a UI control (Q79).** The CLI surfaces a match
   report (`sbscore import`'s output, or a `sbscore match <id>` verb) and the browser's review pane gets
   the same banner, landing together, not staggered across milestones.
6. **The index is reference data, seeded from ADR-0036's labelled corpus, not the product store.** Each
   labelled song's fingerprint is computed once at labelling-commit time and kept in a small local index
   alongside — not inside — `SIBEI_REAL_CORPUS_DIR`. It is not a user's data (ADR-0002) and it is not
   baked/shipped model weight (ADR-0024) — a third, narrower category: a local reference table that
   exists only if a labelled corpus exists, and degrades to "no matches, ever" with none.

## Alternatives considered

| Option | Why not |
|---|---|
| Melodic interval sequence as the primary signal | More natural per music-identification literature (audio fingerprinting's closest analogue), but today's note-level OMR error on real photos is exactly the noise this initiative is trying to reduce — using the noisier signal to drive the matcher first would make matches least reliable exactly where they're most needed. Revisit once retrained models (ADR-0036/V28) close the gap. |
| Match before Stage 1, on the raw image (e.g. perceptual page hashing) | Defeats the purpose — a different edition, scan quality, or key of the same tune would not perceptually hash alike, while the chord progression (the *content*) would still match. Also couples matching to image quality this project already knows varies wildly. |
| Auto-apply a high-confidence match, skip recognition entirely for that page | Directly contradicts ADR-0019's founding decision that every parse is a draft a human reviews — a wrong "confident" match would silently substitute the wrong song's chart, a worse failure mode than a flagged low-confidence note. |
| A cloud song-identification API (e.g. an audio fingerprinting service) | Violates the offline invariant (ADR-0024/ADR-0025) for no reason — the whole point is that the corpus needed to match already lives locally, from ADR-0036. |
| Store the fingerprint index in the product SQLite `Store` | Conflates reference data (looked up, never owned by a user) with a user's library (ADR-0002); also ties the index's schema to the score-document migration discipline (ADR-0028) for data that isn't a score. |

## Consequences

- **A genuinely new pipeline stage, cleanly bounded.** `docs/omr-pipeline.md` gains a pointer to this
  ADR and SLICES.md's V29; the existing stage table (1 / 2a / 2b / map / grammar / beat-mapping /
  correction) is unchanged, because matching sits *beside* correction, reading its input, not inside the
  recognition pipeline.
- **Depends on ADR-0036 having produced at least a handful of labelled, fingerprinted songs** before
  there is anything to match against — V29 is sequenced after V27/V28, not in parallel with them.
- **Does not depend on, or block, V17f's default-engine swap.** Matching reads whichever engine's output
  `mapOmrToScore` already produced; it has no opinion on which engine that is.
- **A new false-positive risk, contained by the confidence gate and by routing every acceptance through
  the ordinary op log** — a wrong suggestion costs a human one rejected banner, never a corrupted score,
  by the same undo/versioning guarantees that already cover every other kind of correction.
