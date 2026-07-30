# REQS: sibei-score

> **Historical record.** This is the initial idea capture, written before any design
> work. It is deliberately left as written. Where it differs from `CONTEXT.md`,
> **`CONTEXT.md` wins** — see the decision register there and the ADRs in
> `docs/adr/`. Sentences since superseded are marked inline below.

Open questions and their answers live in `QUESTIONS.md`.

## The idea

A notation app specialised for jazz lead sheets, and deliberately nothing wider
than that.

There are two ways into the same score. A browser UI where a human edits notes,
chords, key signature and accidentals, and a CLI that humans and AI agents use to
act on the score directly. The CLI is a first-class way to drive the app rather
than a thin script wrapped around the UI, so an agent should be able to do
anything a human can do within MVP scope. The two must never be able to disagree
about the state of the score.

The third pillar is import. Point the app at a PDF or a photo of an existing lead
sheet, parse it, and land the result in the app in editable form. Fix what the
parse got wrong, then export a clean PDF.

## What a lead sheet is, for scope purposes

A single staff carrying the melody, with chord symbols above it and bar numbers
along the way. Key signature, time signature, accidentals. Ties between notes,
triplet brackets, and double barlines where sections change.

One rendering convention matters more than the rest: four bars per line. That is
the standard for jazz charts and the PDF export has to honour it.

## How it runs

Locally, and only locally. No hosted service, no accounts, no network
dependency at runtime.

> **Superseded by [ADR-0001](docs/adr/0001-local-first-hosting-shaped.md).** This is
> now a statement about the MVP *deployment*, not the architecture. The app is built
> local-first but hosting-shaped, so a hosted web service is a later deployment change
> rather than a rewrite.

It ships as a Docker container. Start the container, open a browser, and the UI
is there. The frontend is React or Svelte built with Vite (either is fine, the
choice can fall out of whichever rendering library we settle on). The CLI runs
against the same container.

> **Partly superseded.** The choice does *not* fall out of the rendering library —
> VexFlow is framework-agnostic — so it remains open (`QUESTIONS.md` Q65). Two
> containers, not one: `api` (Node) and `worker` (Python), per
> [ADR-0005](docs/adr/0005-node-owns-api-python-omr-worker.md).

## MVP requirements

**Import.** Take a photo or a PDF of a lead sheet and parse it.

**Represent.** Parse into a real interchange format rather than something
bespoke. MusicXML is the obvious candidate, so scores can leave the app and be
opened elsewhere.

> **Superseded by [ADR-0004](docs/adr/0004-own-model-musicxml-as-codec.md).** The
> opposite was decided: a bespoke internal model *is* the runtime truth, and MusicXML
> is a codec used only at import and export. The intent here — that scores can leave
> the app and be opened elsewhere — is fully preserved by MusicXML export.

**Display.** Render the parsed result in the browser in editable form.

**Edit.** Individual notes (pitch, duration, position), key signature,
accidentals, chord symbols.

**Notation coverage.** Ties, triplet brackets and double barlines, both detected
on import and rendered on screen and in the PDF.

> **Partly superseded by [ADR-0021](docs/adr/0021-notation-coverage-boundary.md).**
> Double barlines are supported, rendered and editable but **not detected** — barline
> classification is a known weak spot of the chosen OMR engine
> ([ADR-0010](docs/adr/0010-hybrid-omr-pipeline-oemer.md)), so the user adds them.
> Ties and triplets are detected. Scope also *grew* here: sections, rehearsal letters,
> repeats with endings and pickup bars are all in.

**Transpose.** The whole chart, melody and chord symbols moving together.

**Export.** PDF, laid out four bars per line.

**CLI parity.** Import, edit, transpose and export are all reachable from the
CLI, usable by an agent with no human in the loop.

## Out of scope for the MVP

Playback and audio of any kind. Articulations, dynamics, ornaments and grace
notes. Multi-staff or multi-part scores, piano scores, drum notation. Lyrics.
Multi-user collaboration. Anything approaching a full MuseScore or Sibelius
feature set.

## Things I believe but haven't verified

Optical music recognition on a phone photo is the riskiest part of the whole
product, and it will not be perfect. The product should probably treat every
parse as a draft that a human corrects, not as a finished import, and the UI
should be built around that assumption from the start.

MusicXML is the right interchange format even if it turns out to be a poor
internal representation.

Chord symbols are semantically different from notes and will need their own
editing affordances rather than being bolted onto note editing.
