# NoteEvents v1 fixtures

Hand-made against the audio repo's `schemas/note-events-v1.schema.json`
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
| `drums-valid-unsupported.json` | valid v1 but `instrument: drums`: valid to read, refused at import |
