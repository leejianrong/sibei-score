# The real-photo control set

`make eval` scores the synthetic corpus **and** this small set of hand-labelled real photographs,
side by side, so the gap between them is visible (ADR-0020). The synthetic set can only ever be as
honest as this set keeps it — **including deliberately bad photos** (skew, shadow, a phone held at an
angle, a creased page) is the point, not an accident.

## Why this directory is (almost) empty

The repo ships with no real photographs — nobody has added any yet, and a fabricated "real" photo
would defeat the purpose. This is a genuine gap the harness is built to expose, not hide. Adding real
charts is a manual step; the harness picks them up automatically once they are here.

## The format

Each control example is a **pair** sharing a base name:

```
tests/fixtures/eval/real/
  body-and-soul.json      # ground truth: a serialised Score (the correct transcription)
  body-and-soul.jpg       # the photograph (.jpg, .jpeg or .png)
```

- The `.json` is a `Score` document — the same shape `sbscore open <id> --json` prints, or that the
  MusicXML/OMR import produces once corrected. Transcribe the chart by hand (or import and correct it),
  then save the corrected score here as ground truth.
- The image is a real photo of the same printed chart.

`make eval` runs each image through the recogniser, maps the result to a `Score`, and scores it
against the paired `.json` with the same metrics as the synthetic corpus (note accuracy, chord
accuracy, metrically-valid bars).

## Adding one

1. Photograph a printed lead sheet with a phone. Keep some deliberately rough.
2. Transcribe it correctly (CLI, browser, or import-then-correct) and save the score as
   `tests/fixtures/eval/real/<name>.json`.
3. Save the photo as `tests/fixtures/eval/real/<name>.jpg`.
4. `make eval` — the `real` row now reflects it.

Keep this set small (a dozen or so). It is a control, not a training set.
