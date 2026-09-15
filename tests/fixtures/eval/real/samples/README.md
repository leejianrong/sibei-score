# Sample images for validating the recogniser

Drop 5-10 real lead-sheet photos in this folder to check the trained Stage-2a recogniser against
real paper (V15, ADR-0031). This is a quick, local eyeball set, separate from the scored control
set one level up (`../`), which needs a ground-truth `Score` for each image.

## What to put here

Photos or scans of a **single-staff lead sheet**: one treble staff, a melody on it, and chord
symbols written above. Printed engraving matches the training domain best — the synthetic corpus is
engraved, not handwritten — so a printed fake-book page, or a chart you rendered in sibei-score and
printed, transfers more fairly than a handwritten manuscript. A range of quality helps: a clean scan
and a rough phone photo (skew, shadow, a creased page) stress different things.

## These files are not committed

The `.gitignore` here keeps everything you drop out of git. That is deliberate: most real lead sheets
are copyrighted, and this folder is a local validation aid, not a redistributed asset. Only this
README and the `.gitignore` are tracked, so the folder survives a clone while your images stay put.

## Turning one into a scored control-set entry

The images here give a qualitative look. A real accuracy number needs a ground-truth transcription
per image. The easy route is render-print-photograph: a photo of a chart you rendered in sibei-score
has the very `Score` you rendered as its exact ground truth, with nothing to transcribe by hand. See
`../README.md` for the paired `(name.jpg, name.json)` format that `make eval` scores.
