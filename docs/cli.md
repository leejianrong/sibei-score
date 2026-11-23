# The `sbscore` CLI reference

`sbscore` authors and edits jazz lead sheets from the command line. It is a thin **HTTP client of
the local `/v1/` API** (ADR-0002) — never a second way into the store — so anything it does, the
browser can do too, and the two cannot disagree about a chart. Every edit is an *operation*
addressed by beat or by id.

`sbscore --help` prints the live, authoritative list of verbs, address forms and exit codes; this
page explains them with examples. Where the two differ, the `--help` output (and the code behind it)
is right.

## Running it

There is no globally-installed binary yet; you run the CLI from the repo with `pnpm sbscore <verb>`,
and it talks to a server you start separately.

**From source** (Node ≥ 22 and [pnpm](https://pnpm.io)):

```sh
pnpm install
pnpm serve                       # the API on http://127.0.0.1:4321 — leave it running
pnpm sbscore list                # in another terminal
```

**Against Postgres** instead of the local SQLite file (V19; the hosted deployment's store):

```sh
sbscore serve --database-url postgres://sibei_app:…@host:5432/sibei     # or SBSCORE_DATABASE_URL
```

Connect as an ordinary role that owns its tables — the server refuses a superuser (or `BYPASSRLS`) role,
because row-level security would not apply to it (`--allow-rls-bypass` opts out, for local development
only). `--data` cannot be combined with it. The URL is never printed: the startup line shows only scheme,
host, port and database. Only `SBSCORE_DATABASE_URL` is read, never the generic `DATABASE_URL`, so an
unrelated environment cannot switch your library. `--blobs DIR` (or `SBSCORE_BLOBS`) places the scans and
export cache; by default they sit beside where the SQLite file would be. `pnpm test:postgres` runs the
adapter's tests against a throwaway Postgres.

Blobs can live in an S3-compatible bucket instead (SIB2-136): set `SBSCORE_S3_ENDPOINT`, `SBSCORE_S3_BUCKET`,
`SBSCORE_S3_ACCESS_KEY_ID` and `SBSCORE_S3_SECRET_ACCESS_KEY` together (optional `SBSCORE_S3_REGION`, `_PREFIX`,
and `_PUBLIC_ENDPOINT` for the host clients are signed URLs for). Environment only, so no secret is in argv; the
bucket must already exist. `pnpm test:s3` runs the adapter's tests against a throwaway S3 gateway.

**Against the container** ([Quick start](../README.md#the-container--just-run-the-app) has the
`docker compose up`); point the CLI at its port:

```sh
export SBSCORE_URL=http://127.0.0.1:8080
pnpm sbscore list
```

### Talking to the server

| Flag / env | Meaning |
|---|---|
| `--url <base>` / `SBSCORE_URL` | The API base URL. Defaults to `http://127.0.0.1:4321` (the `pnpm serve` default). A trailing slash is ignored. |
| `--json` | Machine-readable JSON on stdout instead of the human text. On every verb. |
| `--if-version N` | Optimistic concurrency on any verb that writes — see [Concurrency](#concurrency). |

## Addresses (ADR-0007)

Anything you edit inside a chart is named one of three ways:

```
bar12.beat3    a beat within a bar — 1-based, fractional (bar12.beat2.5); bar0 is the pickup
bar12.n3       the third item in bar 12
note-17        a stable id (survives edits)
```

Onsets only: **a beat with nothing on it is an error that lists the bar's real onsets**, never a
snap to the nearest note. `sbscore show <id>` prints the addresses the CLI accepts for a chart, so
you never have to guess one. Whole-bar verbs (`section`, `barline`, `repeat`, `ending`) take a bare
bar like `12` or `bar12`.

## Charts

```sh
sbscore new [--title T] [--composer C] [--key K] [--time 4/4] [--bars N] [--pickup] [--id ID]
            [--instrument PRESET]...
sbscore list                                 # every chart: id, title, composer, key, version
sbscore open <id>                            # the full document, as JSON
sbscore check <id> [--json] [--strict]       # list every flagged object: address, kind, reasons (--strict exits 2 if any)
sbscore show <id>                            # the text projection — a four-bar grid with addresses
sbscore duplicate <id> [--id NEW]            # a copy with a fresh history (ADR-0003)
sbscore import <file>...                     # OMR a photo/scan into a new draft chart (ADR-0019)
sbscore import --note-events FILE... [--split-point 60|C4]   # NoteEvents v1 (audio engine) into a draft (ADR-0040); several files = stems of one score
sbscore import FILE.musicxml|.xml|.mxl       # a MusicXML file into an editable draft (SIB2-152; `--musicxml` forces it)
sbscore reparse <id> [--engine oemer|heuristic]  # re-OMR a chart's kept scans into a new draft
sbscore rm <id>                              # delete a chart (destroys its op log; asks in the UI)
sbscore meta set <id> [--title T] [--subtitle S] [--composer C] [--arranger A] [--style S] [--key K] [--time 4/4]
                      [--footer TEXT] [--footer-pages first|last|all]
                      [--signature-policy every|first|page]
                      [--chord-style standard|dash|words|real-book]
                      [--layout lead-sheet|score]
                      [--instrument-names on|off]
                      [--tempo 4=120]
```

`new --instrument` starts a chart from instrument presets, top to bottom, the way Sibelius's new-score list does:
`sbscore new --instrument trumpet-bb --instrument piano --instrument bass --instrument drums`. A preset sets the
part's name and abbreviation, staves and clefs (a piano is a treble and a bass staff under a brace), General MIDI
program, transposition (`trumpet-bb` +2, `alto-sax-eb` +9, `tenor-sax-bb` +14, semitones from sounding to written) and
a percussion staff for `drums`; instrument names are turned on, and `layout: score` when there is more than one staff.
The presets are `lead-sheet` (the plain one-staff chart), `piano`, `voice`, `guitar`, `bass`, `drums`, `trumpet-bb`,
`alto-sax-eb`, `tenor-sax-bb`, `flute`, `violin` and `cello`; an unknown name is refused with the list. The browser's
New chart form has the same picker (add, remove and reorder rows). Without `--instrument` nothing changes.

`show` is the projection an agent reads to learn a chart cheaply; `open` is the raw document.
`new` and `meta set` have no browser control yet for the key and meter (Q79's
one knowing exception); the title block (title, subtitle, composer, arranger, style) has one in the rail; the footer has one, in the score view's rail.

`--subtitle` prints centred under the title and `--arranger` under the composer, right-aligned (SIB2-180).
A literal `\n` in `--composer` starts a second composer line. An empty value removes a subtitle or arranger.
MusicXML carries them as `<movement-title>` and `<creator type="arranger">` (one `<creator type="composer">`
per composer line).

`--footer` is a copyright or credit line printed in the bottom margin of the PDF and the browser
sheet, wrapped to fit between the margins (write `\n` for a line break; an empty `--footer ''`
removes it). `--footer-pages` picks `first`, `last` or `all` pages (the default). It is part of the
chart, so it is a logged, undoable edit and shows in `show`; MusicXML carries the text as `<rights>`
but not the page choice.

`--signature-policy` says where the clef and key signature are drawn: `every` system (the default, and what
a chart without the setting does), the `first` system only, or the first system of each `page`. The
time signature is always printed once. Later systems that lose the prefix get the room back, so their bars
widen. Bar numbers stay on each system. It is a logged, undoable edit with a control in the score view's
rail, it shows in `show`, and MusicXML has no home for it.
`--chord-style` chooses how the chart prints its chords, in the PDF and the browser alike (one render
path, so they match byte for byte): `standard` (the default: `Δ7`, `m7`, `ø7`), `dash` (`Δ7`, `-7`,
`-7♭5`), `words` (`maj7`, `min7`, `min7♭5`, `dim`, `aug`) or `real-book` (`MA7`, `MI7`, `MI7♭5`). It is
a rendering choice only: the stored chord text, `show` and MusicXML are unchanged, and MusicXML does not
carry the style. `standard` clears it. It is a logged, undoable edit with a select in the score view's rail.

`--layout` says how the systems of a chart with several staves are broken (ADR-0041 section 5): `lead-sheet`
(the default, and what a chart without the setting does) keeps the four-bar grid of a lead sheet, `score` breaks a
system when the next bar would not fit the line, the way a score is set (`--bars-per-system` and section breaks
still apply to `lead-sheet` only). `lead-sheet` or an empty `--layout ''` clears it. It is a logged, undoable edit
with a Layout select in the score view's rail, `show` prints `layout: score` when it is set, and MusicXML has no
home for it (a file of several staves imported from MusicXML comes in as `score`).

`--instrument-names on` prints each part's name at the left of its staves, left of the brace and bracket: the full
name (`instrument set --name`) on the first system, the short name (`--short-name`, an empty value removes it) on the
rest, with room reserved only where a name is drawn. `off` clears it. A logged, undoable edit with a checkbox in the
rail's Layout panel; MusicXML carries the names as `<part-name>` and `<part-abbreviation>` but not the on/off choice.

`--tempo` draws a metronome mark, a small note glyph and a number, above the first bar (after the pickup, if any; `4=120`, `4.=60` for a
dotted beat; units 1, 2, 4 and 8; 20 to 400; an empty `--tempo ''` removes it). It is separate from the free-text
`--style` line, and it is notation only: nothing plays. MusicXML carries it as a `<metronome>` and a
`<sound tempo>` (in quarter notes a minute) on the first measure, and reads it back. It is a logged, undoable
edit, it shows in `show` as `tempo: 4=120`, and the score view's rail has a Tempo control.

`import` needs a server started **with a worker** (`sbscore serve --worker URL`, or the compose
stack); without one it is a 503 and every other feature still works (Q80). It takes several files as
one chart, in page order (Q26), waits for the recogniser (CPU-only recognition is minutes, ADR-0025),
and prints the new chart's id. **Every parse is a draft** (ADR-0019): open it, fix the bars flagged
`!` by `show`, and set the key, meter and sections — import defaults the key to C major and the meter
to 4/4 and never detects sections (ADR-0021), so the four-bar layout is wrong until you add them
(ADR-0015). An image with no staff fails with exit 2 and creates nothing (ADR-0018). The source images
are kept forever (ADR-0019), so a chart can be re-parsed later by a better engine.

`import --note-events FILE` takes the audio engine's **NoteEvents v1** JSON (ADR-0040) instead of an
image, and needs **no worker**. The seconds are quantized to bars (using the file's beat grid if it has
one), the key is guessed, and the result is a draft like any other: notes the transcriber was unsure of
are flagged `!` (with their confidence, `c5/4!41`), and **bar 1 is flagged when the file marks no
downbeats**, because then where the bars start is a guess. The engine's warnings are printed under the
success line and kept on the import record. Voice and bass make one melody staff (ADR-0021), drums a
percussion staff, and **piano a grand staff** (treble and bass in one part, set by width): the importer
guesses which hand plays each note (a pitch rule around middle C that follows each hand's recent range
and keeps a chord in one hand where it fits) and says so in a `hand-split:` line, so check both staves.
A chord is one stacked item in one voice (the notes a hand strikes and releases together); a melody over a
held chord is two voices, and a fifth simultaneous line on a staff is dropped with a warning. Correct the guess with `note move` and `hands move` (below), or move the pivot:
`--split-point 62` (a MIDI number, or a pitch like `D4`; default middle C) is kept on the import and
`sbscore reparse <id> --split-point 62` re-splits a piano draft into a new one from the stored file. A file that
is not valid v1, has a `schema_version` other than 1, or names another instrument (guitar, other) is refused with
exit 2 and creates nothing. A silent file imports as an empty one-bar draft with its warnings.

**Several files are the stems of one recording** (`import --note-events voice.json piano.json bass.json drums.json`,
one NoteEvents per separated stem; the same works as a JSON array body or a multipart upload to `POST /v1/imports`,
and in the library's file picker). They land as **one multi-part score on one bar grid**: the beat grid comes from
the stem with the best one, the key is inferred across all the pitched stems, and the parts are ordered voice, piano,
bass, drums (`Voice`, `Piano`, `Bass`, `Drums`, set by width). Each stem's warnings are printed prefixed by its
instrument (`bass: low_confidence: ...`); a stem with no notes becomes an empty part with a warning. Stems that are
not from one recording (a different `source.sha256` or duration), or more than 12, are refused whole with exit 2
naming the stem (`stems[2]: ...`); a guitar or other stem alongside others is kept as a two-staff chord part (read
like a piano) with a warning, rather than refused. A hosted audio job whose worker returns several stems lands the same score, metered
once (ADR-0034 amendment "several stems").

`import FILE.musicxml` (also `.xml`, or a compressed `.mxl`; `--musicxml` forces it for any file name)
reads **MusicXML** through the codec into an editable draft with a fresh history, and needs **no worker**.
Parts, staves and up to four voices a staff become real parts, staves and voices (a draft of several staves is
set by width, `meta.layout` `score`), and the import **never goes silent about what it drops**: a chord past ten pitches (a `<chord/>` note otherwise joins its chord),
lyrics, dynamics, a fifth voice, a mid-piece key or meter change, unsupported articulations or clefs, a file
past 32 parts or 32 staves and the like are listed under the success line (and are the job's `diagnostic` in `--json`).
The file is untrusted, so it is bounded (10 MB of XML, an `.mxl` may not expand past that, nesting is capped,
declared entities are never expanded). A file that is not MusicXML, is `score-timewise`, or is too large is
refused with exit 2 (`invalid-musicxml` / `unsupported-musicxml`, never retryable) and creates nothing.

`reparse` is that re-parse: it re-runs OMR on the scans an import kept (no new upload — the server
reuses the retained images, V14e) and lands the result as a **new** draft, printing its id; the
original chart and any corrections on it are left untouched. `--engine` picks the recogniser —
`heuristic` on a small host, `oemer` where the RAM is there — and without it the worker keeps its own
default (host-appropriate). Like `import` it needs a server with a worker and waits for the job. A
chart with no scan behind it (hand-authored or duplicated) has nothing to re-run and fails with exit 2. An
import id the server does not know (or an image index past the end) is exit 5, and retrying an import job
that has not failed is exit 2.

```sh
sbscore reparse sc_7f3a --engine oemer      # re-run oemer over the kept scans -> a fresh draft id
```

## Notes, rests and chords

```sh
sbscore note add <id> <address> --pitch Eb5 --dur 8 [--accidental auto|show|hide|paren] [--spell]
sbscore note set <id> <address> [--pitch Eb5] [--dur 8] [--tie start|stop|both|none] [--accidental auto|show|hide|paren] [--spell|--unspell]
                [--artic staccato,accent,marcato|none]                        # marks by the notehead; none clears
sbscore note rm  <id> <address>      # bar3.n2.Eb5 removes one pitch of a chord
sbscore note move <id> <address> --to s2[.v1]   # re-home a note, a chord or one pitch (bar3.n2.E4) on another staff, same time and length
sbscore hands move <id> <bars> --from s1 --to s2 [--below C4 | --above C4]   # bars 5, 3-8 or bar3-bar8; a chord splits at the pitch
# A move keeps the note's id and leaves a rest of the same length behind. The target must hold only rests (or a note of the same
# length, which the pitches join as a chord) over that time; anything else, a note in a tuplet, a drum or a slurred note is refused
# naming the bar, never overwritten. One undo takes a whole `hands move` back. In the browser: select a note, "Move to other
# staff" in the inspector; the Staves panel has the range form.
sbscore range copy <id> <span> [--staff s1] [--no-harmony] [--structure] [--out FILE]   # a span (3-6, or bar3.beat2-bar4.beat1) of a staff as a clip, JSON
sbscore range paste <id> <address> --clip FILE|-   # lay a clip at bar9.beat1 (s2.v1.bar9.beat1 on a chart with several staves or voices)
sbscore range clear <id> <bars> [--staff s1] [--harmony]   # empty whole bars of a staff (3-6); --harmony takes their chords and text too
# A clip holds every voice of the span (notes, stacked chords, grace notes, ties, rests), the tuplets and slurs wholly inside it, and
# the chord symbols and text; `--structure` adds barlines and endings for whole bars. Paste **replaces the span** it covers and gives
# every pasted object a fresh id; a one-voice clip lands in the addressed voice, a several-voice clip in the same-numbered voices. It
# never transposes (the clip records its key), refuses a clip from another meter, a tuplet that would straddle a barline and a span
# past the last bar (it says how many bars to `bar add` first). `range.paste` and `range.clear` are ops, so a `batch` and MCP's
# edit_score carry them; one undo takes either back. In the browser: Ctrl/Cmd C, X, V and Duplicate on a selection.
sbscore rest add <id> <address> --dur 4
sbscore rest rm  <id> <address>
# Stacked chord: `note add` onto a beat a note of the same duration already holds adds a pitch to its chord (one
# stem, counted once in the bar; `show` prints `[c4 e4 g4]/4`). `bar3.n2` is the whole chord and `bar3.n2.E4` (or
# `bar3.beat2.E4`) one pitch of it, for `note set` (pitch, accidental, tie, spelling) and `note rm`. Duration and articulations are the
# whole chord's: set them on `bar3.n2`. At most ten pitches; drums struck together stay in separate voices.
sbscore chord set <id> <address> --text "F#m7b5" [--spell]      # upsert a chord symbol
sbscore chord rm  <id> <address>
sbscore text set <id> <address> --text "(unis.)" [--until bar8]   # a text direction above the staff, optional dashed line
sbscore text rm  <id> <address|annotation-id>
sbscore fermata set <id> <address>                               # a fermata over a note or rest
sbscore fermata rm  <id> <address>
sbscore grace add <id> <address> --pitch D5 [--dur 8|16|32] [--slash]   # a grace note before a note
sbscore grace rm  <id> <grace-id|address>                        # one grace by id, or all on a note
sbscore slur set <id> <from> <to> [--placement above|below|auto]  # a slur from one note to a later one
sbscore slur rm  <id> <slur-id|from>
sbscore ottava set <id> <from> <to> --up|--down                  # an 8va (--up) or 8vb (--down) line over a run
sbscore ottava rm  <id> <ottava-id|from>
sbscore lyric set <id> <address> <syllable> [--verse 1-4] [--extend]   # one syllable under a note: hel- begins a word, -lo ends it
sbscore lyric rm  <id> <address> [--verse N]                     # one verse's syllable, or all of the note's
sbscore lyrics set <id> <bars> "text" [--verse 1-4] [--staff s1] [--voice N]   # a verse over a bar range
sbscore dynamic set <id> <address> <ppp|pp|p|mp|mf|f|ff|fff|sf|sfz|fp|rfz>   # a dynamic under a note or rest
sbscore dynamic rm  <id> <address>
sbscore hairpin set <id> <from> <to> --cresc|--dim               # a wedge under a run of notes
sbscore hairpin rm  <id> <hairpin-id|from>
```

Durations are a note value and a dot per dot: `--dur 4`, `--dur 4.` (dotted quarter), `--dur 2..` —
the same spelling `show` prints. `--spell` pins the current enharmonic spelling to the object so a
later transpose leaves it alone (ADR-0017); `--unspell` releases it. Chord text is parsed by the
grammar in `packages/music`; whether the grammar can read it is the server's call, so `--text` takes
whatever you write.

A **text direction** — a cue, a tempo, "unis.", "solo on form" — is free text above the staff at a beat:
`sbscore text set <id> bar4.beat1 --text '(unis.)'`. It is an upsert (one per beat), it prints in the chord
band beside any chord at that beat, and `show` lists it under its bar with the beat and an `annotation-N`
id, which `text rm` takes as well as the beat. MusicXML carries it as `<words>`. In the browser, select a
bar: the Structure panel has a Text directions field.

`--until bar8` (or a bare `8`) adds a **dashed continuation line** after the text, running to the end of bar 8
and closing with a small hook: `text set <id> bar4.beat1 --text 'solo' --until bar8`. The line crosses barlines and
carries on at the start of the next system when it wraps. An empty `--until ''` removes it; leaving `--until` out
on a later `text set` keeps it. The end is stored as the bar's id, so adding or removing bars does not move it, and
`show` prints `---> bar8` after the text. MusicXML carries it as `<dashes type="start|stop">`. The Structure panel
has a "Dashed line ends at bar" field beside the text direction.

A **fermata** is a hold sign over a note or a rest: `sbscore fermata set <id> bar4.n2`, `fermata rm` to take it
off (refused where there is none). It draws above the staff and above the note's own ink, centred on the
head, and the chord band rises to clear it. `show` marks it `^` after the duration (`c5/4^`, `r/4^`), and
MusicXML carries `<fermata type="upright"/>` and reads it back. In the browser, select a note or rest and tick
Fermata. It has no playback length. Charts written before fermatas need no migration.

**Grace notes** are small notes played just before a principal note: `sbscore grace add <id> bar4.n2 --pitch D5
--dur 16 --slash` (`--slash` makes it an acciaccatura, the stem struck through; without it an appoggiatura;
`--dur` is 8, 16 or 32 and only sets flags and beams; up to 8 per note). Adding another to the same note
appends it, so they read in the order added; two or more share one beam. A grace belongs to its note: it is
not a bar item, takes no time and never touches the bar's metric validity, and it follows the note through
`note set`, transpose and parts, and goes with it on `note rm`. `show` prints a `grace` line under the bar
(`bar2   grace  n3: d5/8s grace-1`), and `grace rm` takes that id, or a note's address to clear all its graces.
A grace's accidental follows the key and any earlier grace in its group, not the rest of the bar. MusicXML
carries `<grace slash="yes"/>` notes with no duration before the principal, read back too (a grace before a rest
or with no note after it is dropped with a warning). In the browser, select a note: the inspector has a Grace
notes section. Charts written before grace notes need no migration (an optional field, absent when none).

**Articulations** are staccato, accent and marcato on a note: `--artic staccato,accent` on `note add` or `note
set` (the list replaces the note's marks; `--artic none` clears them; omitting it leaves them alone). They draw
on the notehead side, away from the stem (below an up stem, above a down stem), stacked staccato nearest, with
a staccato dot moved into the next space when it would land on a staff line, and the chord band rises to
clear them. `show` prints them after the duration as `:stac:acc:mar` (`c5/4:stac`). MusicXML carries
`<staccato/>`, `<accent/>` and `<strong-accent/>` (our marcato) in `<articulations>`; any other articulation in
a file is dropped with a warning. Jazz articulations (fall, doit, scoop) are not modelled. In the browser,
select a note and toggle Staccato, Accent and Marcato, then Save. Charts written before articulations need no
migration.

A **slur** runs from one note to a later one, in the same bar or another: `sbscore slur set <id> bar1.n2
bar2.n3`. It is stored as a `spanner` (a kind and the ids of its two notes, so it follows them), setting the
same pair again only changes `--placement` (`auto`, the default, means by stem direction), and removing either
end note removes the slur. `show` lists them as `slur  bar1.n2 -> bar2.n3 slur-1`, and `slur rm` takes that
id or the note a single slur starts on. Both ends must be notes, not rests. MusicXML carries a slur as
`<slur type number placement>` and reads one back. Charts written before slurs have no `spanners` field and
need no migration. Undoable like any edit. A slur draws on the notehead side (above a run of down stems,
below a run of up stems, above when mixed) unless `--placement` chose, rises just enough to clear the notes
and stems under it, stays under the chord band, and splits into two halves where it crosses a line break.
In the browser, select a note, shift-click a second one, and press Add slur in the Selected panel (the same
panel lists and removes a note's slurs).

An **ottava line** puts a run of notes under an 8va or 8vb: `sbscore ottava set <id> bar1.n2 bar2.n3 --up`
(8va: the notes are drawn an octave lower than they sound, the line above the staff) or `--down` (8vb: drawn an
octave higher, the line below). The notes keep their **sounding** pitch in the chart, which is what chords,
`export --for` parts and MusicXML pitches already mean, so `show` still prints the real pitch and only the
engraving and the browser's click targets shift. It is a `spanner` of kind `ottava` (the slur's shape plus an
`octaveShift`), so it follows its notes and a removed end note takes it with it; two lines may not overlap.
`show` lists it as `ottava  bar1.n2 -> bar2.n3 8va ottava-1`, and `ottava rm` takes that id or the note it
starts on. The line is dashed, labelled `8va`/`8vb` where it starts, ends in a hook turned toward the notes, sits
between the notes and the chord row (which rises to make room), and carries over a line break. MusicXML carries
it as `<octave-shift type="down|up|stop" size="8">` (its `down` is our 8va) and reads it back; a two-octave
shift is dropped with a warning. Charts written before it need no migration (`spanners` is optional). In the
browser, select a note, shift-click a second one, and press 8va or 8vb in the Selected panel's Ottava field.

A **dynamic** is a marking from a closed set (`ppp pp p mp mf f ff fff sf sfz fp rfz`) under a note or rest:
`sbscore dynamic set <id> bar1.n1 mf`, `dynamic rm` to take it off. A **hairpin** is a crescendo or diminuendo wedge
under a run: `sbscore hairpin set <id> bar1.n2 bar2.n1 --cresc` (or `--dim`). It is a `spanner` of kind `hairpin`
(the slur's shape), so it follows its notes, a removed end note takes it with it, two may not overlap, and it splits
into two halves where it crosses a line break. `show` prints `c5/4@mf` for a dynamic and `hairpin  bar1.n2 -> bar2.n1
cresc hairpin-1` for a wedge; `hairpin rm` takes that id or the note it starts on. Both are drawn in one row under
the staff (under each staff of a grand staff), which a chart without either does not reserve. MusicXML carries
`<dynamics>` and `<wedge>` and reads them back; a dynamic outside the set is dropped with a warning. Playback is not
modelled. In the browser, the Selected panel has a Dynamic field, and a Hairpin field beside Ottava (shift-click a
second note). Charts written before them need no migration.

**Lyrics** sit under the staff, one syllable per verse on a note (up to four verses, stacked). The quick way in is the
bulk verb: `sbscore lyrics set <id> 1-8 "Ho-ly mo-ments fill the air so _ sweet"` spreads words over the notes of
bars 1 to 8 (`--staff s2`, `--voice 2` pick another), replaces that verse in the range, and is one undo. Words are
separated by spaces, syllables of a word by hyphens (`hel-lo` or `hel - lo`), and `_` is a note the previous syllable is
held over (it draws an extender line). Rests and notes tied from the one before take no syllable; more syllables than
notes is refused with both counts, fewer leaves the rest bare. For one note, `sbscore lyric set <id> bar1.n2 hel-
--verse 2` (a trailing hyphen continues the word, a leading one `-lo` ends it; `--begin|--middle|--end` and
`--text "-lo"` say it outright), and `lyric rm` clears a verse or all of them. `show` prints `c5/4"hel-"2"la"_` (verse 1
bare, verse 2 numbered, `_` an extender). A hyphen is drawn centred between a word's syllables and trails after the text
at a system break; an extender runs to the verse's next syllable; rows are reserved only under a system that has lyrics.
MusicXML carries `<lyric number><syllabic><text><extend/>` and reads it back (a lyric past verse 4, a second one for a
verse, or one with no text is dropped with a warning). A long syllable on a short note can crowd the next one: layout
gives a bar room for its words but spaces notes within the bar by the music alone. In the browser, the Selected panel's
Lyric field sets one syllable (verse, text, extender) and Verse over bars distributes a pasted verse. Playback is not
modelled; charts written before lyrics need no migration.

## Parts, staves and voices

```sh
sbscore part add <id> [--name Piano] [--instrument 0|none] [--transposition -2] [--staff-type standard|percussion|tab] [--clef bass]
sbscore part rm  <id> <p2> [--force]
sbscore staff add <id> [<p1>] [--type standard|percussion|tab] [--clef treble|bass|alto|tenor|percussion]
sbscore staff rm  <id> <s2> [--force]
sbscore voice add <id> [<s2>]                    # the next free voice of a staff, 2 to 4
sbscore voice rm  <id> <s2.v2> [--force]
sbscore clef set  <id> <s2|s2.bar5> --clef bass  # a staff's clef, or a change from bar 5 (--clef none clears a change)
sbscore instrument set <id> [<p1>] [--name Piano] [--short-name Pno.] [--instrument 0|none] [--transposition -2]
```

A score is parts, each with staves, each with up to four voices (ADR-0041); a lead sheet is one of each, and every
command above this section keeps working on it unchanged. `p2`, `s2` and `s2.v2` are the labels `show` prints (the
second part, the second staff of the score in part order, its second voice); stable ids such as `part-2` and `staff-2`
work too. Chords and text sit on one lane above the top staff and need no staff.

**Addresses.** `bar12.beat3` and `bar12.n3` mean staff 1, voice 1 while the score has exactly one staff and one voice.
Once it has more, a bare address is an error (exit 3) that lists the candidates, never a guess:
`s2.bar12.beat3` is staff 2, `s2.v2.bar12.n3` is staff 2, voice 2, and `note-17` still names itself. Every verb that
takes a note address (`note`, `rest`, `tuplet`, `slur`, `ottava`, `fermata`, `grace`) also takes `--staff N --voice M`,
which only writes that qualifier for you. `part rm`, `staff rm` and `voice rm` refuse something holding notes or rests
unless `--force`; a score always keeps one part, one staff, and voice 1. A bar is flagged when any voice of any staff
does not fill it (an empty voice is fine). The PDF and the browser draw only staff 1, voice 1 until the engraver slice lands.

## Transpose, structure

```sh
sbscore transpose <id> --to Eb                                   # change the concert key (ADR-0016)
sbscore bar add <id> [--after <bar>] [--count N]                 # add empty bars, default at the end
sbscore bar rm  <id> <bar>                                       # remove an empty bar
sbscore section set <id> <bar> [--letter A] [--name Bridge]      # a section boundary (ADR-0021)
sbscore section rm  <id> <bar>
sbscore barline set <id> <bar> [--start none|repeat-start] [--end single|double|final|repeat-end]
sbscore repeat set <id> <startBar> <endBar>                      # a repeat pair around startBar..endBar
sbscore ending set <id> <bar> --numbers 1[,2] --role start|continue|stop|start-stop
sbscore ending rm  <id> <bar>
sbscore tuplet set <id> <address> --notes 3 [--in 2] [--over 3]       # bracket --over items from <address> as --notes in the time of --in
sbscore tuplet rm  <id> <address>
sbscore break set <id> <bar> [--join]                            # end the line after <bar>; --join: a section shares the line
sbscore break rm  <id> <bar>
sbscore nav set <id> <bar> --segno|--coda|--to-coda|--fine|--dc|--ds|--dc-al-fine|--dc-al-coda|--ds-al-fine|--ds-al-coda
sbscore nav rm  <id> <bar> [--segno|--coda|...]                  # one mark, or every mark of the bar
```

A section's `--letter` and `--name` each draw as a box above the bar the section starts on, the name beside the
letter (`--letter A --name HEAD` draws both; a name alone draws one box). A name that only repeats the letter is
not boxed twice. The PDF and the browser draw the same bytes. MusicXML carries the letter as `<rehearsal>`; the
name has no home there and stays a named lossy case.

`bar add --after bar8` puts new empty bars after bar 8; every later bar's number goes up (and a section
starting there moves with it), while ids stay. `bar rm` refuses a bar that holds notes, chords, text, an
ending or a section start. Both are undoable.

**Tuplets.** Write the notes at their written values, then bracket them: `tuplet set <id> bar3.beat2 --notes 3 --in 2 --over 3`
makes the three items from beat 2 a triplet (3 in the time of 2). The run closes up to its scaled length and later
items in the bar follow, so a bar of one quarter, three eighths and two quarters fills 4/4. `--in` defaults to the power
of two below `--notes`, `--over` to `--notes`. `tuplet rm <id> <any member>` restores the written lengths. One op, so
one undo; nested tuplets are refused. The browser has the same under Selected, on a note or rest.

**Line breaks.** The layout is a four-bar grid with a forced break at each section (ADR-0015). A chart can say
otherwise: `break set <id> bar6` ends the line after bar 6 (the grid carries on from bar 7); `break set <id>
bar3 --join` lets a bar that begins a section share the previous line, which is how an intro and section A
sit on one line; `break rm` returns a bar to the grid. `meta set --bars-per-system N` (1 to 8) changes the
count for the whole chart. With none of these set nothing changes. `show` lists them on a `lines:` line.
MusicXML carries a break as `<print new-system="yes"/>` and reads one back; `--join` and the count have no
MusicXML form. In the browser, click a bar for its line break and use Bars per line in the rail.

**Navigation marks** (ADR-0021 amendment, SIB2-175). `nav set <id> bar8 --ds-al-coda` puts a mark on a bar. A
`--segno` or `--coda` sign is drawn above the start of the bar; a jump text (`--to-coda`, `--fine`, `--dc`, `--ds`,
`--dc-al-fine`, `--dc-al-coda`, `--ds-al-fine`, `--ds-al-coda`) is drawn in bold italic at its end. A bar holds
a segno and a coda and one jump, so a second jump replaces the first. `nav rm` takes a flag to remove that mark, or
none to clear the bar. `show` lists them on a `navigation:` line. They only mark the page: nothing plays or
repeats from them. MusicXML carries them as `<segno/>`, `<coda/>` and `<sound dacapo/dalsegno/tocoda/fine>` with
the printed words, and reads them back. In the browser, click a bar and use Navigation.

## Undo, redo and batches

```sh
sbscore undo <id>                            # revert the last edit — or the last batch, as one unit
sbscore redo <id>                            # reapply the last undone edit
sbscore batch <id> --ops '[{"type":"note.add", ...}]'           # many operations as one atomic unit
sbscore batch <id> --ops @ops.json                              # the same, read from a file
cat ops.json | sbscore batch <id> --ops -                       # or from stdin
```

Undo and redo replay the append-only op log rather than mutating it (ADR-0003), so a `batch` — and
the browser's multi-edit actions — undoes as a single step. In the browser, ctrl-Z / ctrl-shift-Z.

## Export

```sh
sbscore export <id> [--pdf | --musicxml | --svg] [-o PATH]
                    [--paper a4|letter] [--font normal|jazz]
                    [--page-numbers[=top-right]] [--page-number-format n|page|of]
                    [--page-number-first yes|no] [--blank-staves] [--no-bar-numbers] [--written]
                    [--for bb-trumpet|bb-tenor|eb-alto|eb-bari|f-horn]
```

`--pdf` is the default. `--musicxml` writes MusicXML to open in MuseScore, Finale or Sibelius — it is
a codec at the edges (ADR-0004), lossy in [known ways](../packages/codec), and it ignores `--paper`
and `--font`, which are page choices. `--for` exports a transposing instrument's part (the notes it
reads, transposed). Without `-o` the file is written to the working directory, named after the
chart's title — *Body and Soul* becomes `./Body and Soul.pdf`; `-o` takes a file path, or a directory
to put that name in.

`--page-numbers` prints a number on each page of the PDF; it is off by default, so existing output is
unchanged. Bare, it is top-right; name a place with `--page-numbers=bottom-center` (`top` or `bottom`
with `left`, `center` or `right`). `--page-number-format` is `n` (`2`), `page` (`Page 2`) or `of`
(`Page 2 of 3`), and `--page-number-first no` leaves page 1 bare. These are page choices, so MusicXML
ignores them. The browser's Export rail has the same controls.

`--written` writes a part that has its own transposition (a Bb trumpet beside a concert piano, from a
MusicXML import or `part.set`) at its own written pitch on the PDF or SVG. The print is concert by default
(ADR-0016: the stored score is concert, and this keeps every existing export byte for byte); MusicXML
always writes the transposed part. The score keeps one key signature (the concert one), so the transposing
staff's accidentals are spelled for its own key and drawn against that signature. The rail's Transposing
parts tick does the same, and appears only when the chart has such a part.

`--blank-staves` fills the rest of the PDF's last page with empty ruled staves (a clef, five lines and a
closing line each) for writing in by hand. It is off by default. Only the room the last page really has is
filled, within the margins and above any footer, so a chart that already fills its last page gets none and
no extra page is ever started. A page choice like paper, not stored in the chart, so MusicXML ignores it, and
the browser preview shows the same staves (the rail's Blank staves tick). Nothing can be written in them.

`--no-bar-numbers` leaves the bar number off the head of each line in the PDF (they are drawn by default, on
every line but the first, and never on a pickup). Nothing else moves. It is a page choice like paper, not stored
in the chart, so MusicXML ignores it; the rail's Bar numbers tick drives the preview the same way.

`--svg` writes each page as an SVG file, one per page, named `Body and Soul - page 1.svg`, `... - page 2.svg`. It
is the browser's own page markup, byte for byte (one render path, ADR-0014): the server renders it with the same
`layout` and engraver the browser composes, honours `--paper`, `--font`, `--for` and `--page-numbers`, and an agent
can open the result to look at what it made. Give `-o` a directory (end it with `/`) for a chart of several
pages; a single file name is refused for more than one page, before anything is written. Over HTTP it is
`GET /v1/scores/:id/export?format=svg&page=N` (1 by default), answering with the page count in `x-sibei-pages`; a
page past the end is a 422. **There is no `--png`**: a rasteriser is a native binding, and none ships in the CLI
or the server (ADR-0031 keeps `resvg` a build-time tool), so `--png` is refused with a pointer here. Turn the
SVG into a picture with whatever you have, for instance `rsvg-convert -z 2 page.svg -o page.png`. The MCP
`export_score` tool does not offer SVG, since it has no page choice.

## Audio

```sh
sbscore audio submit take.wav [--instrument piano]   # uploads, queues, prints the job id
sbscore audio list                                   # your audio jobs, newest first
sbscore audio show <id>                              # status, progress, the reason if it failed, or the draft and its warnings
sbscore audio retry <id>                             # requeue a failed job; refused (exit 2) if its audio was already deleted: upload again
sbscore audio rm <id>                                # delete the job and its audio
```

A recording becomes a job that a separate transcription worker picks up, so `submit` returns at once and the
job waits `queued` until a worker takes it. Nothing else is affected while no worker is running. On a hosted
server the file goes straight to object storage by a presigned URL; locally it goes through the API. The
browser's equivalent is the Audio page (`#/audio`, "Transcribe audio" in the library).

When the worker finishes, the result becomes an editable draft in your library: `audio show` prints
`draft: <id>  (sbscore open <id>)` and any warnings (low-confidence notes, a guessed barring, a duration that
disagrees with the file), and the Audio page's "Open the draft" link goes to it. A recording with no sound gives
an empty one-bar draft with the `silent_input` warning. A result that is not valid NoteEvents fails the job and
is not counted against your audio-seconds.

```sh
sbscore audio usage          # audio-seconds transcribed this month, and the allowance if there is one
```

The operator configures the worker and the allowance in the server's environment, not in code:
`SBSCORE_AUDIO_WORKER_TOKENS` (comma-separated `sbsw_…` credentials for the pulling worker; without it there is
no worker surface and jobs wait), `SBSCORE_AUDIO_LEASE_SECONDS` and `SBSCORE_AUDIO_MAX_ATTEMPTS` (defaults 120
and 3), `SBSCORE_AUDIO_FREE_SECONDS` (what each user may have transcribed per calendar month, UTC; unset means
no cap) and `SBSCORE_AUDIO_PLANS` (`usr_abc=unlimited,usr_def=7200` overrides by user id). At the cap the next
job is refused with `quota-exceeded` and a message that says when the allowance renews. The protocol the audio
worker speaks is "Audio worker protocol v1" in ADR-0034's amendment.

## Concurrency

Every write names the version it expects (ADR-0003). Pass **`--if-version N`** — the version you read
earlier — to pin it: you get exit `4` (a stale-version conflict) if someone moved the chart since,
which is the only way to be sure what you are overwriting. Without the flag the CLI reads the current
version first, so an edit is read-modify-write and never a blind overwrite.

## Signing in to a hosted server

A local server has no accounts and needs none. A **hosted** deployment (ADR-0034) gives each person their own
library, and the CLI signs in to it with an API token it is handed — never a password, a session cookie or a
GitHub token.

```sh
sbscore --url https://sibei.example auth login
#   To sign in to https://sibei.example, open:
#     https://sibei.example/#/device
#   and enter this code:  BCDF-GHJK
#   Waiting for approval (the code expires in 10 minutes)...
```

Open the address in a browser you are already signed in to, enter the code, and choose the token's name and
scopes there. The CLI is handed the token once and keeps it. After that every verb works unchanged against that
server.

To ask for less, pass `--scopes read` (or `read,write`) and `--name ci`: the server puts them in the address it
prints, and the approval page opens with them filled in. They are a request, not a grant: the person approving
can change both, and what they approve is what the token gets.

| Verb | What it does |
|---|---|
| `auth login [--scopes S] [--name N]` | The device flow above. `--json` prints one line for the prompt and one for the result |
| `auth login --token-stdin` | The headless fallback: read a token from stdin, check it against the server, keep it. `--token VALUE` also works, but leaves the token in your shell history and process list |
| `auth status` | Who the server thinks you are, where the credential came from, when it expires. Exit `7` when signed out |
| `auth token` | Prints the token and nothing else, so `$(sbscore auth token)` is a token |
| `auth logout` | Forgets the credential for this server. The token stays valid until you revoke it in the browser |

**Where the credential lives.** `~/.config/sbscore/credentials.json` (`$XDG_CONFIG_HOME` is honoured;
`SBSCORE_CREDENTIALS` names another file), mode `0600` in a `0700` directory, written so it is never wider than
that even briefly. It is filed **per server** and sent only to the server it was issued by, so a mistyped `--url`
cannot receive a token meant for another. The CLI warns on stderr if the file is readable by other users.

**In CI,** set `SBSCORE_TOKEN` instead: it is used in place of the file and wins over it, so a job needs no home
directory. `login`, `status` and every error leave the token out of their output; only `auth token` prints it.

A credential the server refuses (revoked in the browser, or past its 90 days) is exit `7` with a pointer back to
`auth login`; a token limited to `read` that tries a write is exit `7` too.

## MCP, for agents

A hosted server is an MCP server. Point an MCP client at `https://<your-server>/mcp` (Streamable HTTP) and it
discovers the OAuth endpoints itself (`/.well-known/oauth-protected-resource`), registers, sends you to the
browser to approve, and gets a token that works on `/mcp` only: its audience is the MCP endpoint, so it cannot
be used on the API, and a CLI token cannot be used there. You can revoke it under **API tokens**.

For a client that launches a local process (Claude Desktop, an editor), `sbscore mcp` serves the same tools over
stdio, using the credential `sbscore auth login` stored (or `SBSCORE_TOKEN`) and `--url`, like every other verb:

```json
{ "mcpServers": { "sibei": { "command": "sbscore", "args": ["mcp", "--url", "https://sibei.example"] } } }
```

Against a local `sbscore serve` it needs no credential at all. stdout is the protocol and nothing else.

The tools are the same on both: `list_scores`, `read_score` (the text projection, which prints the addresses a
write accepts), `create_score`, `edit_score` (a batch at an `expectedVersion`), `undo`, `redo` and `export_score`
(PDF or MusicXML). A result is the API's own JSON; a failure is the API's own error object, so a stale write
carries `currentVersion` and an address miss lists the bar's real onsets. A read-only token (`mcp:read`, or
`read` for the CLI) is refused a write with `insufficient-scope`.

## Exit codes

A contract — branch on these rather than parsing prose:

| Code | Meaning |
|---|---|
| `0` | ok |
| `1` | usage error |
| `2` | validation error (the request was fine, the content could not be applied) |
| `3` | bad address (lists the bar's real onsets) |
| `4` | stale-version conflict (`--if-version` lost) |
| `5` | not found |
| `6` | no server reachable |
| `7` | refused (a guard rejected it) |
| `8` | already exists |
| `9` | rate limited or over quota (back off and retry later) |

## Offline

The CLI and the server it talks to make **no network connection** beyond your own machine — no
telemetry, no account, no cloud. Charts live in a local SQLite library, exports are produced locally.
See [Offline by design](../README.md#offline-by-design).
