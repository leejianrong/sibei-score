# ADR-0040: NoteEvents import — the audio engine's contract becomes a draft

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Jian (direction: ADR-0039 decision 6, audio is in the 2026 hosted launch)
- **Relates to:** the audio repo's `docs/adr/0002-sibei-score-boundary-and-note-events-contract.md`
  (music-audio-transcriber), [ADR-0003](0003-op-log-and-optimistic-concurrency.md),
  [ADR-0005](0005-node-owns-api-python-omr-worker.md), [ADR-0008](0008-imperative-cli-verbs-plus-batch.md),
  [ADR-0013](0013-store-and-flag-invalid-rhythm.md), [ADR-0019](0019-parse-is-a-draft.md),
  [ADR-0021](0021-notation-coverage-boundary.md), ADR-0039 (product direction and schedule)

## Context

The audio engine (a separate repo) turns a recording into `NoteEvents` v1: a JSON document of notes
with onset and offset **in seconds**, MIDI pitch, a 0-1 confidence, an optional beat/downbeat list
and warnings. Its ADR-0002 draws the boundary: the engine never sees bars, clefs or engraving; **this
repo owns everything symbolic** — quantization to a metrical grid, bar/key/time inference, spelling,
review flags, engraving. The reasons it gives hold here too: quantization is a notation problem, it is
testable with no audio, and it can reuse the "parse is a draft" flow OMR import already has (ADR-0019).

This ADR decides how we receive that contract. It adds no new notation: ADR-0021 stays in force.

## Decision

1. **NoteEvents v1 is the only interface.** We read the JSON document and nothing else from the audio
   engine: no audio, no model internals, no MIDI. The JSON Schema is **owned by the audio repo**; we do
   not edit it. We keep a model-owned TypeScript type and validator (`packages/model/src/note-events.ts`,
   the way `omr.ts` is the OMR worker's contract) and copy the audio repo's fixtures into
   `tests/fixtures/note-events/` with the source repo and commit recorded beside them. Contract drift
   is the main failure mode of two repos, so the validator is strict where the schema is
   (`additionalProperties: false`, ranges, the sha256 pattern) and the fixtures are the cross-repo test.

2. **Forward-compatible reading, and unknown majors are rejected.** `schema_version` is the major. An
   absent or `1` is read; any other value (including 2, a string, or a non-integer) is refused with a
   distinct error naming `schema_version`. Within a major we are forward-compatible only in the way the
   schema allows: the contract bumps the major for any change, so we do not silently ignore unknown
   fields — an unknown key under v1 is a validation error, because it means one repo is ahead of the
   other. Every validation error names the failing field path (`notes[3].onset_s`).

3. **Scope: voice and bass, one melody staff.** ADR-0021's single-melody-staff boundary is explicitly
   **kept**. `instrument` of `voice` or `bass` imports; `piano`, `drums`, `guitar` and `other` are
   *valid* NoteEvents but are refused at import with a distinct "instrument not supported yet" error
   (a different kind from "malformed"), until the staves-by-voices model (ADR-0039 decision 3) exists.
   Notes that overlap in time (the engine promises monophony but may not deliver it) are not made
   polyphonic: the quantizer keeps one line, truncating a note at the next onset, and records a
   warning. Bass is written in bass clef only if/when the model gains clefs; until then it is the
   melody staff in treble clef at written pitch, which is a known limitation, not a decision.

4. **Where the code lives.** Three pure, framework-free, Node-free modules in `packages/model`, beside
   `omr.ts` and `omr-map.ts`, so they run in the browser and the server and are testable without audio:
   `note-events.ts` (type + validator), `note-events-quantize.ts` (seconds to ticks) and
   `note-events-map.ts` (quantized notes to a `Score` draft). They need nothing from `music` (no chord
   recognition from audio is attempted), so ADR-0011's `model` / `music` split is not crossed.
   The quantizer has **no randomness and no clock**: the same input gives the same output.

5. **Quantization is deliberately simple.** The grid is the **beat grid when one is supplied**
   (beats with `is_downbeat` define bars; a beat is subdivided on the tick grid, nearest legal
   subdivision wins, ties round down so the result is deterministic); with **no beat grid** the
   quantizer infers a single constant tempo from the median inter-onset interval, assumes 4/4 with the
   first note's bar as bar one, and **emits a warning** that the draft's barring is a guess. Swing-feel
   detection and tempo changes are out of scope: a performance that drifts yields flagged bars, not
   silent repair. Gaps become explicit rests (ADR-0021, ADR-0013 needs them). The quantizer never
   rejects: a bar that does not sum to the meter is stored and flagged (ADR-0013).

6. **It is a draft (ADR-0019).** Mapping infers key (from the pitch-class histogram, a major/relative
   minor guess) and spells pitches with the existing spelling engine; every note carries the engine's
   **confidence** into the model's existing review-flag field, and every NoteEvents `warning` becomes a
   **diagnostic on the import record**. Flags show as `!` in `sbscore show` and highlight in the
   browser exactly as OMR flags do (the flag-parity test covers both). There is no source image; the
   source is the NoteEvents JSON, kept in the BlobStore with the job so the draft can be re-derived by
   a better quantizer later (the ADR-0019 re-parse argument, unchanged). Sections are not detected
   (same advisory as OMR, ADR-0021).

7. **It lands through the existing path, never a new write path.** Import is a **job** (ADR-0001) with a
   new source kind, `note-events`: the document is validated at the boundary (ADR-0029's "validate by
   decoding", here: parse + schema + instrument + size cap), stored in the BlobStore, and the runner —
   which for this kind calls no worker — runs the pure mapper and lands the result through the
   server-only `Applier.import` as one `score.import` with a fresh history, exactly as OMR import and
   duplicate do (ADR-0003, ADR-0008: never the client `/ops` route). A malformed, unknown-major or
   unsupported-instrument file is refused **at the boundary with a distinct, non-retryable error**,
   before a job exists; a runtime mapping failure fails the job like any other (Q80).

8. **Both surfaces (Q79).** `POST /v1/imports` accepts a NoteEvents document; `sbscore import
   --note-events FILE`; and the library's import affordance accepts the same file.

## Consequences

- The audio and notation repos are independently testable: here, NoteEvents fixtures are scored against
  ground-truth scores (SIB2-134, a `packages/synth` extension); there, fixtures against ground truth
  audio. Only an integration check spans both.
- Quantization quality, not audio F1, decides sheet quality. It gets its own number on the V12 harness
  (the NoteEvents-import row) so that improving it is measurable.
- Fixtures are hand-made against the v1 schema while the audio repo's corpus is empty; they are
  replaced or joined by its fixtures when they exist, and the recorded commit says which.
- Guitar stays refused (piano and drums now import, see the amendments below). The error kind is distinct so the
  hosted UI can say "coming soon" rather than "invalid file".
- Transport (how a NoteEvents document reaches us from the GPU worker) is ADR-0039 decision 9
  (pull); this ADR is independent of it, since a file upload and a worker's result are the same JSON.

## Amendment (2026-11-22): what the real transcriber emits

The audio repo's shared fixtures (its `tests/fixtures/note_events/`, copied unchanged) and contract
notes settled four things. `Beat.is_downbeat` is `bool | null`, and real output is **null on every
beat** (warning `downbeats_unknown`): the importer never assumes where bar 1 starts, it infers 4/4 and
starts bar 1 on the beat nearest the first note, and the mapper flags bar 1 as a draft assumption. A
note whose `offset_s` is not after `onset_s` is malformed (their `invalid_offset_not_after_onset`).
A silent or empty document (`silent_input`, no notes) is **not an error**: it imports as an empty draft
with its warnings kept. Soft-attack voices produce late onsets and split notes, so note confidence
drives review flags and the quantizer is tested with onset jitter.

## Amendment (2026-11-23): piano imports as a grand staff with a guessed hand split (SIB2-144)

`instrument: piano` is now notated (`packages/model/src/note-events-piano.ts`; decision 3's refusal list loses
`piano`, and `guitar` and `other` stay refused). The draft is **one part named Piano (General MIDI program 0)
with a treble and a bass staff**, `meta.layout: 'score'` so systems break by width (ADR-0041 section 5), and it
shares the beat grid, snap, key inference and spelling of the other mappers; a silent file is an empty two-staff
draft with its warnings.

- **The hand split is a guess, and the draft says so**: every piano import carries a `hand-split:` diagnostic (on
  the job and under the CLI's success line). The rule is deterministic and goes onset by onset. The notes struck
  together are cut by pitch at every possible point; each cut is priced by the distance of each hand's new notes from
  that hand's recent centre (smoothed, so a hand is stable rather than flipping per note), by reach (an octave and a
  third is free, more is heavily penalised, counting the hand's still-sounding notes, so a wide chord is split and a
  hand does not stretch), by crossing the other hand's held notes, and by a mild pull toward the split point (middle
  C, `splitPoint` in the mapper options). Measured on the synthetic corpus (`docs/eval.md`): about 96% of the notes
  found land on the right staff.
- **Stacked chords** (ADR-0041 "As built: stacked chords", SIB2-243; this replaces an earlier voice-per-tone reading).
  Notes a hand strikes and releases together are one item in one voice carrying all their pitches (the highest carries
  the item), tied per pitch across bar lines; notes that overlap in time without starting together still take the next
  free voice, so a melody over a held chord is two voices. A fifth simultaneous *line* on one staff is dropped with a
  warning, and a chord keeps at most ten pitches (the highest five and lowest five). Pieces are unchanged on the note
  F1 (the same notes are found; they are just written as chords).
- **Correcting the split** is `note move` (one note, chord or pitch) and `hands move` (a bar range, optionally only the
  pitches below or at and above one) from SIB2-244: a re-home of the same onset and duration to another staff, the moved
  note keeping its id and a rest left behind (ADR-0041 "As built: moving between staves").
- **`splitPoint` is reachable (SIB2-244):** `sbscore import --note-events FILE --split-point N`, `POST /v1/imports?splitPoint=N`
  and a field beside the library's import button. It is kept on the job inside the opaque `engine` marker
  (`note-events;split=N`, no schema change: the column already says what the runner does with a job), so a retry reproduces
  the draft. `sbscore reparse <id> --split-point N` (`POST /v1/scores/:id/reparse {splitPoint}`, and "Re-split hands" in the
  score view) writes a **new** draft from the stored document at another pivot, costs no recognition quota and needs no
  worker. `GET /v1/scores/:id/source` carries `kind: "note-events"` for such a draft.

## Amendment (2026-11-24): several stems become one multi-part score (SIB2-147)

The audio engine's separated mix is one NoteEvents per stem. `mapStemsToScore` (`packages/model/src/note-events-stems.ts`)
imports them as **one score on one bar grid**; a lone document still goes to `mapNoteEventsToScore` unchanged. The
transport (the worker's `complete`, the upload) is in ADR-0034's amendment; a set is `{ "stems": [...] }`, at most 12.

- **One grid.** The beat grid comes from the stem with the best one: a usable grid (two or more beats) beats none, then
  marked downbeats, then the most beats, then the instrument order drums, bass, piano, voice, other (with no grid
  anywhere, the stem with the most notes). The origin, meter, tempo and pickup are inferred once from that grid and every
  stem's first note, and handed to each stem's *own* mapper (melody quantizer, piano hand split, drum mapper) through
  `options.shared`, so bar N is the same bar in every part. Every stem is cut to the union of the bars the stems cover; a
  stem that starts late opens with rests, a stem with no notes is an empty part of whole-bar rests with a warning
  (never an error). Bar 1 is flagged when the barring is a guess, once for the score.
- **One key**, inferred over the pitched stems together (weighted by sounding time) and used to spell all of them.
- **Parts in conventional order**, whatever the input order: voice, guitar, piano, other, bass, drums. Names `Voice`,
  `Piano`, `Bass`, `Drums` (a second stem of one instrument is `Voice 2`), GM programs 54, 0, 33 and none (percussion).
  Piano keeps its two staves and the hand-split warning; bass is on a bass clef; `meta.layout` is `score`. Item and staff
  ids are made unique across parts.
- **Refused whole:** stems that are not from one recording (a differing `source.sha256` or `duration_s`), more than 12,
  or none. **`guitar` and `other`** in a set of two or more are kept, not refused, because refusing the stem would discard
  the band and the audio engine's `other` stem is polyphonic chords: they are read like a piano (stacked chords, a
  guessed hand split over two staves, the `hand-split:` warning) in a part named Guitar (GM 24) or Other, with an
  `unsupported-instrument` warning; the same document alone is still refused (decision 3).
- **Diagnostics** are every stem's warnings, prefixed by the stem (`bass: low_confidence: ...`), the grid's own
  warnings once, and one `inferred:` line; review flags (low confidence) survive on the notes.
- Built and scored against **synthetic** stems only (`packages/synth/src/note-events-stems.ts`: the `fullBandChart`
  fixture rendered as lead, piano, bass and drums, one tempo, one hash), because the engine has no multi-stem producer yet.
