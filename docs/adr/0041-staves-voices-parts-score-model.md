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
- **Known imperfect:** instrument names, per-part transposition and cross-staff beams are later items. (The four defects
  this slice first listed, crossing stems, an unmerged third voice, a fermata across the staff from a low note and the
  top-staff-only ottava line, were fixed in SIB2-233, below.)

**Refinement of slice 4 (SIB2-233).** Crossing voices at a quarter or longer note turn their stems away from each other;
voices 1 and 3 on the same unbeamed quarter or half share one stem; a fermata hangs under a note below the staff or in a
stem-down voice (`fermataBelow` joined the vendored glyphs, 63); an ottava line is drawn on, and reserves room above or
below, the staff of its first note. **Clef change drawn (SIB2-241).** `clef set sN.barM` is now engraved: a small clef (three quarters size) in the lead-in of the bar that changes, with room reserved in the bar's prefix on every staff's column; a system head shows the clef in force there at full size and the key signature in that clef's positions; notes, ledger lines, ink and hit-testing read each bar's own clef. No cautionary clef at a system's end. Still imperfect: a crossing at a beamed or tuplet note keeps its numbered stems, voice
4 does not merge onto voice 2, and a voice that crosses at a different onset than its partner's still draws through it.

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
  standard), lyrics, dynamics (chord tones were lossy here until SIB2-247).
- **`writtenPart`** (`packages/music/src/part.ts`) now moves every staff and voice (percussion excepted), the chord lane
  once; a part with its own `transposition` moves by that interval instead of the instrument's and comes back with
  `transposition: 0` (applied). `concert` is still the identity, leaving a part's own transposition to the codec.
  A view has one key signature, so an own-transposition part's key signature is the requested instrument's until the
  engraver draws per-part keys.
- **Printing a part's own transposition (SIB2-239):** a PDF/SVG export is concert by default (ADR-0016; single-staff,
  no-transposition output is byte-identical). `export --written` / `written=yes` / the rail's Transposing parts tick
  runs `writtenPart(score, 'concert', { ownParts: true })`: only staves of a part with its own `transposition` move,
  the chord lane and the one score key stay concert. A per-part key signature is not drawn (the engraver has one).
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

Second half (SIB2-240): the controls that change the shape.

- **The Staves and voices panel** (`StaffPanel.svelte`, `lib/staff-edits.ts`) in the rail: the active staff and voice (a staff row,
  a voice chip row 1-4 each, with the clef name), new staff / voice / part, remove staff / voice / part, a staff's opening clef and
  a clef change from the selected bar, and a part's name, General MIDI program and transposition. Each is the op of the same
  name (`staff.add`, `clef.set`, `instrument.set`, ...), addressed `p1`, `s2`, `s2.v2`, so it is the browser half of the CLI verbs
  and one undo (ctrl-Z, by replay) takes it back.
- **A removal that would take notes with it is not sent.** The row says so ("Remove its notes first, or remove it with its music.")
  and only the explicit "Remove with its music" sends `force: true`; an empty staff, voice or part goes straight away. The
  server's own refusal remains the backstop.
- **New note / rest** (`NewItem.svelte`) sits under the bar panel: a beat, a pitch and a duration, sent as `note.add` /
  `rest.add` at `s2.v2.bar3.beat1`, the qualifier from the clicked staff and the active voice. This is also the first browser
  `note.add`, so a lead sheet gets it too (Q79 debt closed).
- **Keyboard:** the bare keys `1` to `4` pick that voice of the active staff, only on a chart with more than one lane, only
  when the key is not typed into a field or a focused control, and never with a modifier; nothing else in the score view binds a
  bare digit, and ctrl-Z / ctrl-shift-Z are unchanged.
- **Not drawn:** a clef change at a bar is stored and set from the panel, but the engraver draws a staff's opening clef only.
- **Library and export rail:** the library lists title, composer and key, none of which depend on the staff count, so it is
  unchanged; the export rail renders and exports the whole system, MusicXML per slice 5a.

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

**Slice 6b: drum NoteEvents import (SIB2-236).** `instrument: 'drums'` is no longer refused (`NOTE_EVENTS_SUPPORTED_INSTRUMENTS`
gains it; piano, guitar and `other` still are). `mapNoteEventsToScore` hands a drum document to `mapDrumEventsToScore`
(`note-events-drums.ts`), because the melody mapper is monophonic. It shares only the beat grid (`beatGrid`, factored out of
the quantizer, behaviour unchanged) and the sixteenth snap. Each note is a hit: the drum is a recognised `drum_class`, else
the GM key (an unknown key is kept as generic `percussion`, flagged, and named in the diagnostics). Hits become voices as
`drums.ts` describes (hands 1 then 3, feet 2 then 4, the bar's most frequent drum keeping the first voice of its side; a
third simultaneous hit on a side is dropped). A hit is written as the longest quarter, eighth or sixteenth that fits
before the voice's next hit, followed by a rest. It is a flagged review draft like every audio import: low-confidence
hits and unknown keys are flagged, bar 1 is flagged when the barring is a guess. The audio repo's contract is unchanged
and not edited: this only reads `instrument` and `drum_class`. Fixtures: `drums-single-bar.json` (was the refused-instrument
fixture), `drums-rock-groove.json` (README records provenance). A hit's duration is a notation choice, not the recording's.

**Slice 6c: MusicXML unpitched percussion (SIB2-237).** Export: a part whose percussion staves name drums gets a
`<score-instrument id="P1-I36">` (the drum's label) and a `<midi-instrument>` per drum used, with `<midi-channel>10` and
`<midi-unpitched>` (the GM key plus one: MusicXML counts from 1); each drum note is `<unpitched>` with its display pitch,
`<instrument id>` and, when its head is not an ordinary oval or the note overrides its drum's, `<notehead>`. A percussion
part with no named drum writes exactly what slice 5a wrote. Import maps an `<instrument id>` to a drum by its
`<midi-unpitched>` when the drum map knows the key, else by its name; keeps a `<notehead>` only when it differs from the
drum's own; reads an unknown notehead as an x with a warning; and reads **drums struck together** (`<chord/>`
notes, how drum charts write a hat with a snare) as separate voices beside the first (`label+c1`), the voice's gaps
filled with rests, where slice 5a dropped them. A file with a drum staff but no usable instruments reads as the older
one-line staff at the file's own display pitch. Still lossy: stems and beams as the file draws them, a drum's own
`<notehead-text>`, instruments with no drum in the map (kept as plain hits).

## As built: stacked chords (SIB2-243)

A voice held one note-or-rest per onset, so a piano chord, a guitar chord or a block voicing was one **voice per tone**
(the piano importer does this and flags it), which engraves as separate stemmed lines, spends the four-voice limit and
is not how any notation program or MusicXML (`<chord/>`) works. A stacked chord is several simultaneous pitches sharing
one stem, one duration and one beam position, in one voice.

**Decision: a note carries the extra pitches** (`Note.stack?: StackedNote[]`, optional-and-absent, never `[]`). A
`StackedNote` is `{ id, pitch, accidental, tie, spellingPinned }`: exactly what is per-note in notation. The carrying
note's own `pitch` is one member of the chord. Everything per-chord (`onset`, `duration`, `articulations`, `fermata`,
`graces`, tuplet membership, `review`, `confidence`) stays on the carrying note. **No migration** (ADR-0028): a stored
document without `stack` means a lone note, which is every document that exists, and no stored document changes shape, so
`SCHEMA_VERSION` stays 4. Old op logs replay unchanged because the only new behaviour is a `note.add` onto an onset that was
refused before.

Alternatives rejected:

- **(b) a `ChordItem { notes[] }` in `Voice.items`** is the cleaner shape on paper, but it changes `BarItem` for every
  consumer at once (layout, engraver, codec, projection, hit-testing, the importers), needs a v5 migration of every
  stored voice, rewrites every note id into a child, and puts the whole single-note path at risk for a feature most
  charts never use. The chord-as-attribute design keeps every `Voice.items` consumer correct without edits.
- **(a) a membership field on separate sibling notes** (several `Note` items at one onset, joined by a `chordWith` id)
  keeps ids flat, but then every consumer that sums or counts items (metric validity, the `nK` ordinals, tuplets, beams,
  the width model) must learn to skip the followers, and an old reader sees overlapping notes in one voice, which ADR-0013
  would flag as an over-full bar. A dropped follower silently becomes a second note at the same time.
- **(c) infer chords from overlap** (two notes at one onset in a voice are a chord) would change the meaning of stored
  documents that already hold such a bar, and needs a migration for a meaning change (ADR-0028); the stored ones are
  invalid bars today and must stay flagged, not become chords.

**Consequences, in the order they were decided.**

- **One item per onset still holds**, so metric validity counts a chord once (ADR-0013), `nK` ordinals are unchanged,
  and tuplets, slurs, graces and fermatas attach to the carrying note's id, the chord as a whole. Ties, accidentals
  and spelling pins are per pitch (`StackedNote`), which is how MusicXML and notation programs treat them.
- **Ids.** A stack member has its own stable id (prefix `note-`), listed by `idsOf` and so by `nextId`. Removing the
  carrying note's own pitch promotes the lowest remaining stack member into it: the item keeps its id (so slurs,
  tuplets and addresses survive) and the promoted member's own id retires. That is the one id loss, and it only happens
  on an explicit `note rm` of the carrying pitch.
- **Addressing (ADR-0007).** `bar12.n3` is the whole chord, as it always was. One pitch is `bar12.n3.Eb5`: the written
  pitch (case-insensitive, as printed by `show`), which a chord never holds twice, so it is strict and unambiguous and does
  not shift when other pitches are added or removed; a stack member's id (`note-9`) also resolves to that pitch. A pitch
  the chord does not have is an error listing the ones it has. `Resolved.tone` carries the pitch.
- **Ops.** `note.add` onto an onset that a **note** holds in the same voice adds a pitch to its chord; the duration must equal the
  chord's, the pitch must be new, at most ten pitches, no drum (percussion keeps voices), and articulations are refused
  (they belong to the chord: `note set bar12.n3`). A rest, or a note in another voice, is still refused as before.
  `note set bar12.n3.Eb5` changes that pitch's `pitch`, `accidental`, `tie`, `spellingPinned`; `duration`, `head`,
  `drum` and `articulations` are chord-level and refused there with a message that names the chord's address.
  `note set bar12.n3 --dur` therefore moves every member. `note rm bar12.n3.Eb5` removes one pitch; `note rm bar12.n3`
  removes the whole chord, as it always did. "Unchord" needs no verb: `note rm` the pitch, `note add` it in another voice.
- **Transposition** (`transpose`, `writtenPart`) moves every pitch through `mapTones`, honouring each pitch's own pin.
- **Projection.** A chord prints low to high in brackets with its ties per pitch: `n1 [c4 ~e4~ g4]/4`. A bar with no
  chord prints byte-identically to before.
- **Build order.** PR 1: model, ops, CLI addressing and projection (this section). PR 2: layout and engraver (one stem,
  displaced seconds, accidental columns, ledger lines). PR 3: MusicXML `<chord/>` both ways, replacing the
  "chord tones are dropped with a warning" lossy case. PR 4: the NoteEvents piano importer. PR 5: the browser editor.
  Until PR 2 lands the engraver draws only the carrying note's pitch.

**PR 2 as built (SIB2-246): layout and the engraver.**

- **Layout** hands the engraver one `NoteItem` per chord with `tones?: ToneItem[]` (the other pitches, each with its id, the
  accidental glyph resolved against the key and the bar, its display and its own tie role); a lone note has no `tones` key, so
  every single-note chart lays out as it did. Accidentals are resolved low to high within the chord. Ties pair **per pitch**
  (`planTies`): a pitch pairs with a later pitch of the same sound and a tie names the pitch's own id; lone notes pair as before.
  Staff ink (`staffInk`) reaches from the highest head to the lowest, and the stem direction there matches the engraver's
  (the head furthest from the middle line decides, a tie goes down). Bar width estimates add accidental columns (at most three)
  and one notehead when two heads are a second apart.
- **The engraver** (`engrave/src/chords.ts` is the pure geometry; `engraveChord`/`chordInk` in `engrave.ts` the ink): one stem
  from the head at the far end to the head on the stem's side (`StemInput.attachPosition`), so beams and flags measure from the
  stem-side head exactly as for a lone note; heads a second or unison apart cross the stem (walking from the stem's attached end,
  the second met moves, and the next head is free again); accidentals go in columns left of the whole chord, nearest column
  first, an accidental taking the nearest column where it is a seventh (six half spaces) clear of those already there; ledger
  lines are one rule per line spanning every head that needs it; dots sit right of the rightmost head, one row per space; marks
  go on the head side (the chord's far end from the stem) and fermatas over its highest head; each pitch registers its own tie
  anchor, and its tie arcs up for the chord's upper half and down for the lower (`TieEnd.tieUp`).
- **Not done here, and deliberate:** a stacked chord moves as a whole against another voice (each of its pitches counts in `noteShifts`, but the chord's own heads do not re-pack); clef-change
  and percussion staves never stack (a note on a percussion staff refuses a stack).
- **Three columns for a unison-plus-second cluster (SIB2-253).** `headColumns` gives each head a column across the stem (0 the stem's side,
  1 the far side, 2 one head further out), the first where no head within a second already sits; F, F#, G needs all three, since the G is a second
  from both. Layout's width, the engraver and the browser's hit-test all read it.
- Proofed with `pnpm proof stacked-chords` and `pnpm proof piano-chords` (new fixtures, committed snapshots); no existing
  snapshot moved and the browser/server byte-identity test covers both new fixtures.

**PR 3 as built (SIB2-247): MusicXML `<chord/>`.** Export writes the carrying note, then one `<chord/>` note per other pitch,
each with the chord's duration, voice, staff and time modification and its **own** pitch, accidental and `<tie>`/`<tied>`;
articulations, fermata, graces and slurs ride the first note only, and the tuplet start/stop mark too. A transposing part
moves every pitch (`writtenView`). Import joins a `<chord/>` pitched note to the note before it in its voice (the carrying
note keeps its own pitch, so a round trip reproduces the stored order), and **replaces** the old "a chord note was dropped:
one pitch per voice" case. Still named, never silent: a chord note with no note to join, a rest or unpitched one, a repeat of a
pitch already in the chord, and a chord past ten pitches. Drums struck together keep the voice-per-drum reading (slice 6c).

**PR 4 as built (SIB2-248): the NoteEvents piano importer.** `mapPianoEventsToScore` now groups each hand's notes that are
struck at one grid point and released at one (after the chord-end alignment it already did) into a unit, gives the unit one
voice (`assignVoices` works on units, so the "fifth simultaneous line is dropped, an overlap cuts the soonest-ending voice
short" rules are the same rules, one level up), and writes it as one item carrying the highest pitch with the others as its
`stack`, every pitch with the same tie. Confidence is the chord's lowest and it is flagged when any member is. A chord keeps at
most ten pitches (highest five and lowest five). The synthetic ground truth (`packages/synth`) writes its chords the same
way, and `truthNotes` expands a chord into its struck pitches, so note F1 is still F1 on (tick, pitch). On the same events the
importer returns the same struck notes as the voice-per-tone version on every heavy seed; the table in `docs/eval.md` moved
only because the ground truth's note order, and so each note's jitter draw, changed. The drum importer (ADR-0041 slice 6c) is
untouched: two limbs on one beat stay two voices, which is the convention for a drum chart.

**PR 5 as built (SIB2-249): the browser editor.** A click on any head of a chord selects the chord (the carrying note's id, so
slurs, tuplets and the inspector keep addressing it) and remembers which head was hit; `hit-test.ts` gives each head its own
box where the engraver draws it (the stem-side column, and the far-side head one notehead across; a beam that flips a chord's
stem moves a far-side head by one notehead, which the click margin absorbs) and the selection outline is the union of the heads.
The inspector gains **Chord pitches**: each pitch with Remove (when the chord has more than one), a typed pitch with Add pitch,
and Add above / Add below (a diatonic third from the top / bottom pitch). Add is `note.add` onto the chord's own onset with its
duration; Remove is `note.rm` by position and pitch (`s2.v1.bar3.beat2.E4`, which the address grammar now accepts at a beat as
well as at an ordinal), and both keep the chord selected so a chord can be built in a row. Duration, articulations and fermata in
the inspector are the whole chord's, and the pitch field edits the carrying note's pitch. Per-pitch **tie, accidental and
spelling pin** closed in SIB2-252: clicking one head of a chord selects that pitch (hit-testing already returned the head), and a
"Chosen head" section of the inspector sets its tie, accidental display and spelling lock at once, each a `note set` at the pitch's
address (`note set bar3.n2.E4 --tie start` on the CLI). A lone note has no such section.

## As built: moving between staves (SIB2-244)

The correction for a wrong piano hand split is a **re-home**: the same onset and duration, another staff or voice. Two ops
share one core (`packages/api/src/ops/move-ops.ts`): `note.move` (target a note, chord or `bar3.n2.E4` pitch; payload `to`
`s2` or `s2.v1`) and `hand.move` (payload `from`, `to`, `first`, `last`, optional `below`/`above`, a pitch: below is strictly
lower, above is at or higher). Decisions:

- The moved note **keeps its id**; a pitch taken out of a chord keeps its own id too, except the carrying pitch (the chord's
  id), which stays with the chord, so the copy that moves gets a new one. Every id the move chooses is recorded in `ids`, so
  replay and undo reproduce it (ADR-0003); a `hand.move` is one undo unit.
- The source is **filled with a rest** of the same length (a voice never has a hole); a chord that loses only some pitches stays,
  smaller.
- The target must hold only rests (a rest the span cuts into is split, the remainder re-written as rests) or a note of the same
  onset and length, which the pitches join as a chord. Anything else is **refused naming the bar**, never overwritten. Also
  refused: a note in a tuplet, a drum, a whole note carrying a slur or ottava, grace notes joining another chord, and a
  voice the target staff does not have (`voice add`). A `hand.move` that moves nothing is an error, not a silent success.
- Surfaces: `sbscore note move <id> <addr> --to s2[.v1]`, `sbscore hands move <id> 3-8 --from s1 --to s2 [--below C4]`, the
  inspector's "Move to other staff" (the chosen head alone when one head of a chord is chosen) and the Staves panel's range
  form. MCP takes both through `edit_score`'s operations (the enum is `OPERATION_TYPES`). The text projection is unchanged.


## As built: instrument names on the system (SIB2-286)

- **Model.** `Part.shortName?` and `meta.showInstrumentNames?`, both optional-and-absent (ADR-0028, no migration;
  `SCHEMA_VERSION` stays 4). Off is stored as absent, so every chart made before this lays out and renders byte-identically.
- **Layout** (`packages/layout/src/names.ts`): with the option on, the full name heads the first system and the short name
  every later one. Room comes off the *left* of a system (`LayoutSystem.x`/`width`), only on a system that draws a name,
  and counts the braces and bracket that sit between the names and the staves. `LayoutSystem.names` carries each name's
  right edge and the staves it is centred on. Widths are an estimate (no glyph is measured, ADR-0015); the engraver anchors
  the text at its right edge, so an underestimate spills into the margin and never onto a staff. A width-fit (`score`)
  break plans every line at the first system's narrower width.
- **Engraver** (`engrave/src/names.ts`): `<text class="se-instrument-name">`, in the chart's text face.
- **Surfaces.** `instrument.set`/`part.add` take `shortName` (empty or null removes it), `meta.set` takes
  `showInstrumentNames`; `sbscore instrument set --short-name`, `meta set --instrument-names on|off`; the Staves panel's
  short-name field and a Layout-panel checkbox. MusicXML writes and reads `<part-abbreviation>`; an import does not turn the
  names on. Fixture `instrument-names`.

## As built: score setup from instrument presets (SIB2-272, SIB2-288)

- **Catalogue** (`packages/model/src/instruments.ts`, plain data): lead-sheet, piano (treble + bass), voice, guitar, bass,
  drums (a percussion staff), trumpet-bb (+2), alto-sax-eb (+9), tenor-sax-bb (+14), flute, violin, cello. Each carries a
  name, short name, General MIDI program, transposition (sounding to written) and its staves and clefs. The applier, the CLI's
  error text and the browser's picker all read this one list.
- **`score.create` gains `instruments` (preset ids, top to bottom) and a recorded `parts`.** The applier resolves the ids to
  parts with fresh `part-N`/`staff-N` ids and **records the resolved parts in the payload**, authoritative on replay, so
  a later change to the catalogue never alters what an old log builds. A setup turns `showInstrumentNames` on when any part
  has a name and sets `layout: 'score'` when there is more than one staff. No `instruments` (or an empty list) is the old
  create, unchanged. An unknown preset is a validation error listing the known ones.
- **Surfaces.** `sbscore new --instrument piano --instrument bass --instrument drums` (a repeated option: `Flags.repeated`);
  the New chart form's `InstrumentPicker` (choose, change, move up/down, remove rows; empty is the lead sheet).
  `tests/unit/instrument-setup.test.ts` pins that both build the same score.

## As built: page setup (SIB2-287)

- **Model.** `meta.page?: { margin?: {top,right,bottom,left}, staffSize?, systemGap? }`, **millimetres**, every field optional
  and absent keeping the layout's own default (ADR-0028: no migration, `SCHEMA_VERSION` stays 4). A page with no field set is
  removed, so a chart that never used it is byte-for-byte what it was.
- **Layout** (`pageInputFromMeta` in `layout/src/page.ts`): the staff size is the page scale (`pointsPerUnit` = size in points
  over the staff's 40 units), so everything scales with it, text included; margins and the system gap are converted through the
  same scale and keep their physical size. `layout()` merges the score's setup *under* the caller's `PageSpecInput` (an explicit
  `pointsPerUnit` or margin side wins, and margins then follow the caller's scale), so the server and the browser, both calling
  `layout()` with the same input, still agree byte for byte. Paper stays a render choice.
- **Surfaces.** `page.set` (flat `marginTop|Right|Bottom|Left`, `staffSize`, `systemGap`; null clears; tenths of a mm; ranges in
  `PAGE_LIMITS_MM`), `sbscore page set`, the rail's Page setup panel (`PageSetupPanel.svelte`), a `page:` line in `show`.
  Fixture `page-setup`.
