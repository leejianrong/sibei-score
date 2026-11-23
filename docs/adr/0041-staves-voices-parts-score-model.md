# ADR-0041: The score model becomes parts × staves × voices

- **Status:** Accepted 2026-11-23 (the maintainer said "go ahead" to starting SIB2-151 on this design). Implementation
  begins now on `main`; the hosted launch ships from the tag `launch/2026-11-23`, cut before it, on the current model.
- **Date:** 2026-11-22
- **Deciders:** Jian, in design discussion (the direction is ADR-0039 decision 3); this design is the agent's proposal
- **Supersedes (in part):** the single-staff, single-voice, one-time-signature parts of
  [ADR-0004](0004-own-model-musicxml-as-codec.md) and [ADR-0021](0021-notation-coverage-boundary.md)
- **Relates to:** [ADR-0003](0003-op-log-and-optimistic-concurrency.md), [ADR-0007](0007-position-addressing-stable-ids.md),
  [ADR-0013](0013-store-and-flag-invalid-rhythm.md), [ADR-0015](0015-four-bar-layout-engine.md),
  [ADR-0016](0016-transposition-mutation-vs-part-view.md), [ADR-0028](0028-score-document-schema-versioning.md),
  [ADR-0038](0038-full-notation-is-the-long-term-direction.md), [ADR-0039](0039-product-direction-and-schedule.md)

## Context

`Score` is `bars[]`, and a `Bar` holds one list of notes and rests, its tuplets, chords, annotations, barlines and
ending. That is one staff and one voice. The real pages we have (a full-band intro with a grand staff, bass clef and
drum staff; two voices; ottava) and the audio project's piano (V4), drums (V5), guitar (V6) and multi-stem score (V8)
all need more. Every op, address, layout rule and engraver path assumes the single voice, so the shape has to be
decided before anything else is added to it.

## Decision

### 1. Three levels, with a global measure grid

```
Score
  meta                      title, composer, style; layout policy ('lead-sheet' | 'score')
  measures[]                the global grid: id, number, time/key (when they change), tempo,
                            start/end barline, ending, review      ← what Bar's structure is today
  sections[]                unchanged: rehearsal letters and form (bar numbers)
  harmony[]                 chord symbols and annotations, anchored to (measure, onset)
  parts[]                   an instrument or voice with one or more staves
    Part: id, name, instrument (GM program), transposition, staves[]
      Staff: id, type ('standard' | 'percussion' | 'tab'), clef (per staff, changeable per measure)
        StaffBar (per measure): voices[]
          Voice: 1–4; items[] (notes and rests, onsets in ticks from the measure start), tuplets[]
  spanners[]                slurs, ottava, hairpins, glissandi: start and end object ids
```

A lead sheet is one part, one staff, one voice, plus the harmony lane. **It stays the default view**; its layout
keeps ADR-0015's four-bar grid. `meta.layout` selects the policy, so a multi-staff score breaks systems by width and
shared barlines instead.

Why a *global* measure grid: bar numbers, barlines, endings, repeats, rehearsal sections and time signatures are
properties of the form, shared by every staff. Storing them per staff would let two staves disagree about where bar 12
is. Why a *global* harmony lane: chord symbols are read once, above the top staff, not once per staff.

### 2. Compatibility is the design constraint

- **Stable ids are unchanged** (`note-17`); every existing id survives migration.
- **Addresses stay valid.** `bar12.beat3` and `bar12.n3` resolve against the first staff, first voice when the score
  has exactly one of each (every existing chart). A score with more is **strict**, as ADR-0007 is: an address that
  could mean two things is an error listing the candidates, never a snap. A qualifier selects one: `s2.bar12.beat3`,
  `s2.v2.bar12.n3` (staff, voice; names for parts and staves are display labels, ids are the stable form).
- **Ops default to the first staff and voice.** An old op payload without a `staff` or `voice` field replays
  unchanged, so ADR-0003's undo-by-replay and ADR-0028's "old operation shapes stay readable forever" both hold.
  New optional `staff`/`voice` fields and new ops (`part.add|rm`, `staff.add|rm`, `voice.add`, `clef.set`,
  `instrument.set`) extend the set; `score.import` carries the new document shape.
- **Migration is deterministic** (ADR-0028): schema vN→vN+1 wraps each `Bar` into a measure, its `items`/`tuplets`
  into one part, one staff, one voice, and its chords and annotations into `harmony`. A fixture carries a real document
  through, and a replay test proves an old log still produces the same score.

### 3. Metric validity, per voice

ADR-0013 stays: bars are stored and flagged, never repaired. A measure is flagged when **any voice** in any staff does
not fill it; a voice with no items is allowed and draws nothing (explicit rests remain first-class where written).

### 4. Staff types and extensions are additive

A `percussion` staff maps pitch to a drum and notehead (a note gains an optional `head`: normal, x, diamond…); GM pitch
plus `drum_class` from NoteEvents feeds it. `tab` adds optional string/fret on notes, later. Articulations, grace notes
and slurs are optional note fields or `spanners`; none changes the shape above. Lyrics would be a per-voice lane, later.

### 5. Layout and engraving

`layout` gains **system-wide time alignment**: horizontal positions come from onsets across all staves and voices, so
simultaneous notes line up; vertical spacing, brackets and braces, and per-staff clefs are layout decisions. The engraver
adds voice-aware stems, rest placement and cross-voice collision handling. The browser/server byte-identical render
rule (ADR-0014/0015) is unchanged.

### 6. Naming: "part"

The shipped feature `export --for` and the browser's part preview (V6) are a **transposition view**: the same notes, a
different written key, never a copy (ADR-0016). They keep their verbs and flags. In the model, **`Part`** means an
instrument line. A later *part extraction* (print one part from a full score) is a render-time view that selects parts,
again with no copy.

## Alternatives considered

| Option | Why not |
|---|---|
| One `Score` per part | Cannot align barlines, endings, rehearsal marks or cross-staff material; the global grid is the point. |
| Keep `Bar.items` as voice 1 and bolt on `voices2plus` | Two ways to say the same thing; every consumer needs both paths forever. |
| Flat event list with absolute ticks, no bars | Cleaner for audio, but bars carry addressing, validity, barlines and layout; the measure grid keeps them. |
| MusicXML as the model | Rejected by ADR-0004: it is a codec at the edge. |
| Chord symbols per staff | Duplicates one fact and invites disagreement; one lane above the top staff. |

## Consequences

- A schema migration, new fixtures and a replay test are owed (ADR-0028), and every package that touches `Bar` changes:
  `model`, `music` (part view), `layout`, `engrave`, `codec`, the applier and ops, the CLI text projection (ADR-0009)
  and the browser.
- Hosted documents written before the change migrate on read, so the launch is not blocked by this design.
- The audio project's piano, drums, guitar and multi-stem scores, and playback, depend on this landing first.
- ADR-0021's "one time signature per chart" is replaced by an optional per-measure change on the global grid.

## Open questions

- A maximum voices per staff (proposed 4) and the stem-direction convention.
- Whether harmony can ever attach to a part other than the top (proposed: not until a case demands it).
- Where tempo and swing feel live for playback (proposed: the measure grid).
- The first slice order (proposed: model + migration + codec, then ops and addresses, then layout, engraver, CLI/UI/MCP,
  then percussion, then tab).

## Acceptance and implementation strategy (2026-11-23)

The open questions above are accepted as proposed: at most **4 voices per staff** (stems up for voices 1 and 3,
down for 2 and 4); harmony attaches to the top part only until a case demands more; tempo and swing live on the
measure grid; slice order as listed.

**Implementation is a refactor first, then capability.** Slice 1 introduces the new document shape, its ADR-0028
migration and a set of accessors (e.g. the items of staff *s*, voice *v*, measure *m*), and moves every consumer of
`Bar.items`, `Bar.tuplets`, `Bar.chords` and `Bar.annotations` onto them, with **no change in behaviour**: every
existing test, snapshot, and the browser/server byte-identity test must pass unmodified, which is the proof that a
single-staff, single-voice chart is unchanged. Only then do later slices add multi-staff/voice capability (ops and
addresses, then layout time-alignment, then engraving, then CLI/UI/MCP, then percussion, later tab). Hosted launch
hotfixes branch from the tag, not from `main`.
