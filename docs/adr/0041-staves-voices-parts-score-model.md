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

## As built: slice 1 (SIB2-225, schema v4)

The document shape landed with **no behaviour change**; every snapshot and the browser/server byte-identity test pass
unmodified. Exact field names (all JSON-plain; `packages/model/src/score.ts`):

```
Score    { schemaVersion: 4, id, meta, bars: Bar[], sections, harmony: HarmonyBar[], parts: Part[], spanners? }
Bar      { id, number, startBarline, endBarline, ending, review, lineBreak? }          the global measure grid
HarmonyBar { barId, chords: Chord[], annotations: Annotation[] }                      one entry per bar
Part     { id, name, instrument: number | null (GM program), transposition: number (semitones), staves: Staff[] }
Staff    { id, type: 'standard' | 'percussion' | 'tab', clef: Clef, bars: StaffBar[] }
StaffBar { barId, voices: Voice[] }
Voice    { index (1-based), items: BarItem[], tuplets: Tuplet[] }
```

- **The grid keeps the name `bars` and the type `Bar`** (the ADR's "measures"): renaming it would touch every consumer
  and every test for no change in meaning. A later slice may rename it.
- A voice is identified by `index` within its staff-bar, not by an id; staves and parts have ids (`staff-1`,
  `part-1` after migration). Clef is per staff for now (nothing draws any but treble); a per-bar change is a later slice.
- `harmony` and each staff's `bars` are keyed by `barId`, not parallel to `bars` by position, so a bar insert, move
  or removal cannot desynchronise them; readers treat a missing entry as empty. Writers keep them dense.
- `spanners` is unchanged (optional-and-absent), as the ADR's lane.
- **Migration v3 to v4** is a pure rearrangement (every id, onset and tick untouched); the only new ids are `part-1`
  and `staff-1`. Op payloads are unchanged. A `score.import` in an old log carries a v3 document and is migrated as it
  is folded (the logged payload is left as written), so old logs replay to the same score.
- **Accessors** (`packages/model/src/staves.ts`): `barView(score, bar, select?)` / `barViews(score, select?)` return a
  `BarView`, the old `Bar` shape rebuilt for one staff and voice (`VoiceSelect { staff?, voice? }`, default first staff,
  voice 1) from the grid entry, the voice and the harmony lane; `withBarView` / `withBarViews` / `mapBarView` write
  one back; `annotationsOfBar` / `chordsOfBar` read the lane cheaply. `makeBar` still builds a `BarView` and
  `makeScore` files it, so a one-staff chart is still one call. Nothing outside `staves.ts` and the migration walks
  `parts` or `harmony` by hand, except `idsOf`.

## As built: slice 2 (SIB2-226, ops and addresses)

- **Ops** (`packages/api/src/ops/structure-ops.ts`): `part.add|rm`, `staff.add|rm`, `voice.add|rm`, `clef.set`,
  `instrument.set`. New ids and the chosen voice index are *recorded* in the payload, so replay and undo reproduce
  them. Staff type is the tag only. A part, staff or voice holding notation is refused unless the payload carries
  `force: true` (the way `bar.rm` refuses a bar with content); a score keeps one part, one staff and voice 1, and a
  part keeps one staff (remove the part instead). `voice.add` takes the lowest free index, 2 to 4. `StaffBar.clef`
  (optional, absent by default, no migration) is a clef change at a bar; `clef.set` on `s2` sets the opening clef, on
  `s2.bar5` a change, and `clef: null` there clears it.
- **Content ops have no `staff`/`voice` payload field: the staff and voice are part of the address.** Every op that
  targets bar contents already carries an address, so one mechanism serves note, rest, tuplet, slur (both ends),
  ottava, fermata and grace, and a target can never disagree with a field. An old payload (`bar12.n3`) is what it
  always was, and means the first staff, first voice while the score has one of each.
- **Addresses** (`model/src/address.ts`): `s2.bar12.beat3`, `s2.v2.bar12.n3`, `v2.bar12.n3`; `s2` and `s2.v2` name a
  staff or voice (`staff rm`, `voice rm`), `s2.bar5` a staff's bar (`clef set`). Staves count across parts in order.
  Strictness is as ADR-0007: with more than one staff, or a staff with more than one voice, an unqualified or
  partly qualified note address is an `ambiguous` failure listing the full qualified candidates (CLI exit 3, the
  address class); `no-such-staff` and `no-such-voice` list what exists. Chord and text addresses ride the harmony
  lane and never need a qualifier. Ids resolve anywhere, and the resolution carries the `select` to write back with.
- **Metric validity** is per voice: `scoreMetrics`, `scoreBarReview` and the projection's `!` flag a bar when any
  voice of any staff fails to fill it; an empty voice is valid. `transpose` moves every staff and voice (chords once).
  `bar.rm` refuses a bar any staff holds.
- **Surfaces.** CLI: `sbscore part|staff|voice|clef|instrument`, plus `--staff N --voice M` as sugar for the
  qualifier. The projection prints the parts, staves and voices only when the score has more than the lead-sheet
  shape (a default chart's text is byte-identical), the other voices under `s2.v1`-style headers, and addresses with
  the qualifier. MCP takes the ops through its batch. The browser still edits staff 1, voice 1 (selecting a staff or
  voice is slice 5).
- **Not drawn yet.** The engraver (slice 4) still draws staff 1, voice 1 only; a multi-staff score renders without
  error. Layout alignment is slice 3's.

## As built: slice 3 (SIB2-227, layout)

Layout now aligns staves and voices; the engraver (slice 4) does not draw them yet. No schema change. Details and the
output contract are in `agent_docs/architecture.md` ("Staves and voices in the layout").

- **Additive output.** `LayoutSystem.staves`, `groups` and `staffSpan`, `LayoutBar.alignment`, and an optional `x` on
  note, rest, chord and annotation items appear only for a multi-staff or multi-voice score. Every single-staff
  single-voice chart's layout, every committed snapshot and the browser/server byte-identity test are unchanged.
- **`meta.layout: 'lead-sheet' | 'score'`** is the multi-staff system-break policy of section 5, added as an optional
  field (ADR-0028): no migration, `SCHEMA_VERSION` stays 4. `lead-sheet`/absent keeps the four-bar grid; `score` breaks
  by width. No op or verb sets it yet (a later slice, with its CLI verb and UI control, Q79).
- Braces come from a part's staves, the bracket from there being several parts; there is no explicit grouping field.
- `makeStaffedScore` (`packages/model/src/build-staves.ts`) builds multi-staff scores for tests and fixtures without ops.

## As built: slice 4 (SIB2-228, the engraver)

The engraver draws every staff and voice that layout emits. No schema change. Details and the module map are in
`agent_docs/architecture.md` ("How the engraver draws a staved system"); what was decided here:

- **One path, one mode.** `engraveBar` gained a `BarMode`; the single-staff call passes `SINGLE_STAFF`, every field at its
  old value, so every committed snapshot and the browser/server byte-identity test pass unmodified.
- **Stems by voice.** With two or more voices holding music, voices 1 and 3 stem up and 2 and 4 down; a lone voice keeps
  the pitch-based rule. Layout's ink measurement follows (`voiceStems`), so the chord row clears forced up stems.
- **Collisions.** Rests offset two half-spaces per voice; the later voice's head moves aside for a second, a crossing or a
  unison of different heads; a unison of one head is shared; a moved head's accidental stays at the unmoved x.
- **Clefs** treble, bass, alto, tenor and percussion from five SMuFL glyphs added to the vendored slice (`fClef`, `cClef`,
  `unpitchedPercussionClef1`, `noteheadXBlack/Half/Whole`; the slice is now 58 glyphs). Key signatures follow the clef.
- **Percussion** is a one-line staff with x heads and stems up; the drum-to-line mapping is slice 6. **Tab** draws five
  plain lines until its own slice.
- **Layout touch-ups the engraver needed:** the first column starts later when it opens with an accidental or a repeat
  sign (`ALIGN_ACCIDENTAL_ROOM`, `ALIGN_REPEAT_START`), and forced stems count toward a staff's ink.
- **Known imperfect:** voices that cross draw each stem through the other's head; three voices with up stems are not
  merged into chords; a fermata sits over the staff, not over a low note inside it; instrument names, per-part
  transposition and cross-staff beams are later items; an ottava line is the top staff's only.

## As built: slice 5a (SIB2-229, MusicXML and `writtenPart`)

- **Export** (`packages/codec/src/export.ts`): a `<part>` per part, a `<score-part>` with its name and, when it has
  one, a `<midi-instrument>` (GM program is 1-based in MusicXML); several parts share a `<part-group>` bracket and a
  part of two or more staves has `<staves>`, `<part-symbol>brace` and a `<clef number>` per staff, as the layout draws
  them. Each staff's voices follow one another, a `<backup>` of the measure so far starting every voice after the
  first, a `<forward>` for a gap, and `<voice>` is `4 * staffIndex + voice` (a single staff's voice 1 is still `1`) with
  `<staff>` only when the part has several. Chords, text, rehearsal letters and the tempo are written once, in the first
  part; barlines and line breaks in every part. A clef change is a `<clef>` in that measure's attributes. A percussion
  staff's notes are `<unpitched>` with their display pitch only (no drum noteheads or instrument map exists yet), and a
  part of only percussion staves is on MIDI channel 10. A single-staff, single-voice score's output is unchanged
  byte for byte.
- **A transposing part** (`Part.transposition` is semitones from sounding to written): the file holds written pitch and
  a `<transpose>` (the opposite direction in MusicXML: Bb trumpet is diatonic -1, chromatic -2), the part's own key
  signature moved by the same spelled interval, and import brings the notes and the score key back to concert. Both
  directions use the spelled interval, never re-spell by key, so the move is exactly reversible.
- **Import** reads every part, staff and voice. The first part sets the bar grid and everything that belongs to the
  whole score (key, meter, tempo, chords, text, rehearsal letters, barlines, line breaks); later parts contribute notes,
  clefs and a transposition. A staff's voices keep this codec's numbering when the file uses it, else rank in numeric
  order onto 1 to 4. Notes that overlap in one voice number (a backup with no `<voice>`) become separate voices. A
  draft of more than one staff gets `meta.layout: 'score'`. Bounds (untrusted input): 32 parts, 8 staves a part, 32
  staves in all, 16 distinct voice numbers a staff then 4 voices, durations past 400 quarters read as zero, a
  nonsense step/octave/staff number clamped; a file past a bound is read up to it with a named warning.
- **Still lossy, named:** a part's missing name (an unnamed part is written as the title, then `Part N`, and read back as
  unnamed), `meta.layout` (not written), a part's bracket/brace grouping (derived, not read), a note's accidental on a
  percussion staff, keys needing more than seven accidentals once written for a transposing part, a clef change
  inside a bar (moved to the bar's start), clefs other than G2/F4/C3/C4/percussion (read as the nearest, tab as
  standard), chord tones, lyrics, dynamics.
- **`writtenPart`** (`packages/music/src/part.ts`) now moves every staff and voice (percussion excepted), the chord lane
  once; a part with its own `transposition` moves by that interval instead of the instrument's and comes back with
  `transposition: 0` (applied). `concert` is still the identity, leaving a part's own transposition to the codec.
  A view has one key signature, so an own-transposition part's key signature is the requested instrument's until the
  engraver draws per-part keys.
- **`meta.layout` has its op, verb and control** (SIB2-232): `meta.set` takes `layout: 'lead-sheet' | 'score' | null`
  (`lead-sheet` and null clear it, so absence is the one way to say the default), `sbscore meta set --layout`, a Layout
  select in the score view's rail (the same `meta.set`, one ctrl-Z undoes it), a `layout: score` line in `show` when set,
  MCP through its batch. Slice 3's "no op or verb sets it yet" is closed.
- **`Part.group` is not added.** Brackets stay derived from the part count and braces from a part's staves. A field
  nobody reads is a trap (the engraver, slice 4, draws what slice 3's layout derives), and the one thing it would buy,
  grouping some parts but not others (a horn section bracketed apart from the rhythm section), has no op, verb or control
  to set it and no file that needs it yet. It would be additive and optional (ADR-0028, no migration) when it does; MusicXML
  `<part-group>` is written as one bracket round all parts and not read.
- **The text projection** (`show`) prints the structure block only for more than the lead-sheet shape, so a
  single-staff single-voice chart is byte for byte as before (tests pin it); the address hint now names an address that
  exists (`s1.v2.bar3.n2` for a one-staff two-voice chart) and a percussion staff no longer says `percussion` twice.


## As built: slice 5b (SIB2-229, the browser editor)

The editor opens and edits any staff and voice (this supersedes slice 2's "the browser still edits staff 1, voice 1").

- **Hit-testing reads the layout's `staves`.** `pageItemBoxes`, `findItem` and `pageBarBoxes` (`packages/ui/src/lib`) walk
  `system.staves` when it is present, with the engraver's own `placeAligned`, `noteShifts`, `restShiftOf` and the staff's
  clef, so a click resolves to the staff and voice it was drawn on; a lead sheet takes the unchanged path (`staffIndex` 0,
  `voice` 1). Each box and each bar band carries its `staffIndex`, and a chord's x is the aligned `item.x`.
- **The active lane** (`lib/lanes.ts`: `Lane { staff, voice }`, 1-based as the address grammar numbers them) is set by a click and
  shown in the stage bar (`Staff 2 · bass · Voice 2`) and in the inspector, only when the chart needs a qualifier
  (`needsQualifier`: more than one staff, or a staff with more than one voice). Edits of an existing note go by id; edits by
  position (a rest replaced, a note added) carry `qualifierOf(score, lane)`, which is empty for a one-staff, one-voice chart
  so its ops are byte-identical to before.
- A slur or ottava joins two notes of one lane only; the controls stay off across lanes.

## As built: slice 6 (SIB2-230, percussion and the drum map)

A drum kit on a five-line percussion staff. No schema change: the two new `Note` fields are optional-and-absent
(ADR-0028 needs no migration for those), so `SCHEMA_VERSION` stays 4 and every committed snapshot and the byte-identity
test pass unmodified.

- **The drum map** (`packages/model/src/drums.ts`, plain TypeScript): `DrumId` (`kick`, `snare`, `side-stick`, `clap`,
  `hihat`, `hihat-open`, `hihat-pedal`, `ride`, `ride-bell`, `crash`, `crash-2`, `splash`, `china`, four toms, two floor
  toms, `cowbell`, `tambourine`, and a generic `percussion`) to a `DrumDef`: label, the General MIDI key it writes
  (`gm`, MusicXML's `<midi-unpitched>`), the **display pitch**, a default head and a default voice. The places follow common
  kit notation: kick F4 (bottom space, stems down, voice 2), snare C5 (third space), closed hi-hat G5 x above the top line,
  open hi-hat the same place with a circled x, pedal hi-hat D4 x below the staff (voice 2), ride F5 x on the top line, ride
  bell a diamond, crash A5 x on a ledger line, toms E5, D5, B4, A4 from the top space down, floor toms G4 and E4.
  `drumForGm` reads GM 35-81 (several keys per drum: 35 and 36 kick, 38 and 40 snare); `parseDrum` reads names and
  aliases; `drumOfNoteEvent` takes a NoteEvents `drum_class` when it is recognised, else the key.
- **The model.** `Note.drum?: DrumId` and `Note.head?: NoteheadKind` (`normal | x | diamond | circle-x`). A drum note's
  `pitch` is its **display pitch**, the place on the lines counted as treble (MusicXML's `<display-step>`), so the layout's
  ink, ledger lines and the engraver's positions need no drum code of their own. Drums are never transposed (`transpose`,
  `writtenPart`).
- **One line or five.** The slice-4 one-line percussion staff stays for a staff whose notes name no drum (the `full-band`
  snapshot is that case). A percussion staff is a **kit** (five lines) as soon as one note names a drum: derived
  (`isDrumKitStaff`), not stored, so there is nothing to keep in step and no migration.
- **Voices.** A voice holds one item per onset (no chords), so a hat and a snare struck together are two voices. Hands
  are voice 1 (stems up), feet voice 2 (stems down), and a hand hit that shares a moment with voice 1 goes to voice 3 (up,
  so its stem lands on voice 1's); a second feet hit goes to voice 4. Voices 3 and 4 hold filler rests that are not
  drawn. The feet voice's rests sit lower so they clear the snare and toms.
- **Ops, CLI, UI.** `note.add` takes `drum` (a name or id; no `pitch`) and `head`; `note.set` takes `drum` and `head`,
  `null` clearing; both refuse a drum or head off a percussion staff. `sbscore note add --drum snare --head x`,
  `note set --drum --head`; the text projection prints `snare/8` and `kick/4:diamond`. The Inspector gains a Drum picker
  and a Notehead control for a note that has a drum (adding a note is not in the browser yet, so there is no new add
  control; the staff chooser is slice 5b's).
- **Known imperfect:** a crash struck with the hi-hat (a second apart) uses the engraver's head-shift, not a stacked
  chord; no legend; the open hi-hat has the circled x but no "o" above; `tab` is still five plain lines.
