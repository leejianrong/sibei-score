# NoteEvents v1 fixtures

## Copied from the audio repo

`valid_bass_line.json`, `valid_silent_voice.json`, `invalid_offset_not_after_onset.json` and
`invalid_unknown_major.json` are **copied unchanged** from `music-audio-transcriber`
`tests/fixtures/note_events/`, branch `v2-sheet-music-contract`, commit d47846e (its PR #4). `invalid_*`
must be refused. Real transcriber output sets `is_downbeat` null on every beat (`downbeats_unknown`), so
bar 1 is a draft assumption here.

## Hand-made (jittered), kept for the quantizer

The rest were made by us against the same schema, because the audio repo's synthetic clips are easier
than real ones (constant tempo, notes on half-beats):

Against the audio repo's `schemas/note-events-v1.schema.json`
(`music-audio-transcriber`, schema file last changed in commit 3f6b9ee, which was also repo HEAD when these were made).
That repo's `tests/fixtures/` was empty at the time, so these were **not copied from it**: they are
synthetic, generated once with small deterministic timing jitter (onsets ±20 ms, beats ±5 ms), and
use public-domain melodies (Ode to Joy, Twinkle Twinkle) or an invented walking-bass line. No real
recording or real score is involved. Replace or join them with the audio repo's own fixtures when it
has some, and update this note with that repo's commit.

We do not own or edit the schema (ADR-0040); `packages/model/src/note-events.ts` validates against it.

| File | What it exercises |
|---|---|
| `voice-ode-beats.json` | voice, 120 bpm 4/4, beat grid with downbeats, 4 bars, a dotted rhythm |
| `bass-walking-beats.json` | bass, 100 bpm, walking quarters, one low-confidence note (0.41) and a warning |
| `voice-twinkle-no-beats.json` | voice, empty `beats` with a `no_beats` warning: tempo must be inferred |
| `drums-single-bar.json` | `instrument: drums`, one bar of kick, snare and hi-hat (it was the refused-instrument fixture until drums became supported) |
| `drums-rock-groove.json` | `instrument: drums`, 120 bpm 4/4, four bars, jittered (onsets ±15 ms): hi-hat eighths with an open hat (`drum_class`), kick on 1 and 3, snare on 2 and 4, a crash, one low-confidence hit and one key (70) the drum map does not know. Generated once by a small deterministic script; no recording is involved. |
| `piano-two-hands.json` | `instrument: piano`, 4 bars, light jitter: made by `generatePianoScore({ seed: 2, bars: 4 })` rendered with `pianoScoreToNoteEvents(..., { seed: 2, level: 'light' })` (`packages/synth/src/note-events-piano.ts`), so synthetic: a right hand of melody, chords and inner lines over a left hand of bass, stride or arpeggios, valid against the same v1 schema. No recording or real score is involved. |
| `audio-piano-truth.json` | `instrument: piano`, ground truth for the audio project's seeded two-handed clip (right-hand melody over left-hand triads, left hand below MIDI 55, 20 notes). Copied unchanged from `music-audio-transcriber` `tests/fixtures/note_events/valid_piano_truth.json` at commit `869c95d` (their PR #8). |
| `audio-piano-baseline.json` | `instrument: piano`, the audio project's classical CQT baseline run on the audio of the same clip (37 estimated notes: extra and merged notes, no velocities, no beats). NOT their model's output. Same source sha256 as the truth file. Copied unchanged from `valid_piano_baseline.json` at `869c95d`. |

## The audio project's four-stem mix (SIB2-147)

`audio-mix4-{vocals,drums,bass,other}.json` are **copied unchanged** from `music-audio-transcriber`
`tests/fixtures/note_events/valid_mix4_{vocals,drums,bass,other}.json` at commit `96e56cd` (the version after their fix to
the stem hashes). Ground truth for the four stems of one seeded synthetic mix (tone renderer, 4 bars at 100 bpm): one
`source.sha256` and `duration_s` (10.1 s) shared; `vocals` is `voice`, `bass` is `bass`, `other` is polyphonic chords
(instrument `other`), `drums` has GM pitches with `drum_class`. Every fourth beat is a downbeat here (real output has
`null`). The main multi-stem fixture: `tests/unit/note-events-stems.test.ts`.
