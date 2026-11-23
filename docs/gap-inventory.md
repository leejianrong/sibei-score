# Gap inventory: the real lead-sheet pages against the editor and engraver

Produced for SIB2-148 (epic SIB2-E12, [ADR-0039](adr/0039-product-direction-and-schedule.md) decision 5).
The question: how far are the model, ops, layout, engraver, MusicXML codec, CLI, UI and (planned) MCP
from reproducing the eight real pages we hold?

**Rights.** The pages are copyrighted and not rights-cleared ([ADR-0036](adr/0036-real-corpus-labelling-and-dataset-strategy.md)).
This file is a feature-level inventory only: names of notation features and counts of pages. It holds no
note, lyric, chord sequence, page image or crop, and nothing here may be turned into a transcription.

## The pages

| Key | Page | Legibility |
|---|---|---|
| S1 | A Charlie Parker tune, real-book page 1 of 2 (`examples/`, PDF) | Vector PDF, fully legible. Full-band intro, then the head |
| S2 | The same tune, page 2 (`examples/`, PDF) | Fully legible |
| W | A Bud Powell tune (`examples/`, PDF) | Fully legible, hand-lettered real-book style |
| LJ | A Roy Eldridge tune, printed edition p. 1 of 2 (`samples/little-jazz.png`, ~520 px wide) | Legible at feature level |
| GE | A Hoagy Carmichael ballad (`samples/georgia-lead-sheet.jpg`, ~490 px) | Feature level; notes marginal |
| FM | A standard in a hand-lettered book (`samples/fly-me-to-the-moon-lead-sheet.jpg`, ~300 px) | Coarse features only |
| MO | A Bobby Timmons tune (`samples/moanin.jpg`, ~230 px) | Coarse features only |
| MF | A Rodgers tune, Coltrane version (`samples/my-favourite-things.jpg`, ~390 px) | Coarse features only |

FM, MO and MF are low resolution. A feature is counted for them only where it is unmistakable; blank
means "not seen", not "not there". A feature that is only probable is marked `?` and **not** counted.

## Features present, by page

`x` = clearly present, `?` = probable at this resolution (not counted).

| # | Feature | S1 | S2 | W | LJ | GE | FM | MO | MF | Pages |
|---|---|---|---|---|---|---|---|---|---|---|
| F01 | Page number printed (or "Page 1 of 2" header) | x | x | | x | x | x | x | x | 7 |
| F02 | Hand-lettered real-book styling (notes and chord text) | x | x | x | | x | x | x | x | 7 |
| F11 | Ties, including across a barline | x | x | x | x | x | x | x | | 7 |
| F04 | Chord alterations in parentheses, `7(#11)`, `7(b5)` | x | x | x | x | x | | | | 5 |
| F05 | Slash chords stacked diagonally, root over bass | x | x | x | x | x | | | | 5 |
| F03 | Clef and key signature on the first system only | | x | x | | x | | | x | 4 |
| F06 | Parenthesised or alternate chords, `(Gmi7 C7)`, `(N.C.)` | x | | | x | x | | x | | 4 |
| F07 | Triplet / tuplet brackets | x | x | x | | x | | | | 4 |
| F08 | Slurs (phrase curves over several notes) | x | x | | x | x | | | | 4 |
| F09 | Text directions anchored to a place in a bar (cues, "unis.", "break") | x | x | | x | | | x | | 4 |
| F10 | Whole-bar rests | x | x | x | | x | | | | 4 |
| F14 | Free page text: closing instructions, copyright, credit, notes paragraph | x | x | | x | | | | x | 4 |
| F12 | System breaks that do not follow a four-bar grid (3- or 5-bar lines, a section sharing a line with the bars before it) | x | | | x | x | | | | 3 |
| F13 | Style / tempo text | x | | | x | x | | | | 3 |
| F15 | Navigation marks: segno, D.S., D.C., Fine, "to end" | x | x | | x | | | | | 3 |
| F16 | Rehearsal letters in boxes, plus named boxes ("Intro", "HEAD") | x | x | | x | | | | | 3 |
| F17 | Repeat barlines | x | | | | x | | | x | 3 |
| F17b | 1st / 2nd endings | | | | x | x | | | | 2 |
| F18 | N.C. (no chord) | x | | | x | | | | | 2 |
| F19 | Articulations: staccato, accent | x | x | | | | | | | 2 |
| F24 | Extra title-block fields: subtitle, arranger, two composers (supported, SIB2-180) | x | | | x | | | | | 2 |
| F25 | Empty ruled staves left at the page bottom | | | | | x | | x | | 2 |
| F26 | Parenthesised (cautionary) accidentals | x | x | | | | | | | 2 |
| F20 | Fermata | x | | | | ? | | | | 1 |
| F21 | Ottava line ("8" with bracket) | x | | | | | | | | 1 |
| F22 | Dashed continuation line after a text direction | x | | | | | | | | 1 |
| F23 | Metronome mark with a note glyph | x | | | | | | | | 1 |
| F27 | Grace notes (supported, SIB2-185) | ? | ? | | | | | | | 0 (probable 2) |
| F28 | Multi-staff system: grand staff, drum staff, bracket and brace | x | | | | | | | | 1 |
| F29 | Bass clef | x | | | | | | | | 1 |
| F30 | Two voices on one staff | x | | | | | | | | 1 |
| F31 | Drum notation: x and diamond noteheads | x | | | | | | | | 1 |
| F32 | Pickup bar, double and final barlines, flat/minor keys | x | x | x | x | x | x | x | x | 8 (supported) |

Not seen on any page: cue notes, mid-chart key or time change, lyrics, dynamics, bar numbers, multi-bar
rest numbers, jazz articulations (fall, doit, bend).

## Support matrix

`S` supported, `P` partial, `M` missing, `-` not applicable. **MCP is not built** (V22): the star means
the status is what the plan implies. V22a's tools are read, `batch` plus addresses, export and render,
so MCP can do what the ops can and nothing more; its column follows the Ops column.

| # | Feature | Model | Ops | Layout | Engrave | MusicXML | CLI | UI | MCP* | Where it breaks |
|---|---|---|---|---|---|---|---|---|---|---|
| F01 | Page number / page header | M | M | M | M | - | M | M | M | No field, no footer or header band; the title block exists on page 1 only |
| F02 | Hand-lettered styling | - | - | S | S | - | S | S | S | `--font jazz` (Petaluma) and the rail toggle exist |
| F03 | Clef and key on first system only | M | M | P | S | - | M | M | M | Layout puts clef + key on every system (`widths.ts`); no policy to turn that off |
| F04 | Parenthesised chord alterations | S | S | S | P | P | S | S | S | `@sibei/music` rejects `7(#11)`, `7(b5)`, `7(#5)`, `(MA7)`. Stored verbatim, flagged for review, drawn as plain text; MusicXML gets text only |
| F05 | Stacked slash chords | S | S | S | P | S | S | S | S | Engraver draws root and bass inline on one baseline, not stacked |
| F06 | Parenthesised alternate chords | P | S | S | P | P | S | S | S | Parser rejects the parentheses, so the chord is flagged; no "alternate" notion |
| F07 | Tuplet brackets | S | S | S | S | S | S | S | M | Closed by SIB2-166: `tuplet.set`/`tuplet.rm`, `sbscore tuplet`, the Tuplet section of the item inspector. Nested tuplets are out of scope |
| F08 | Slurs | M | M | M | M | M | M | M | M | Nothing exists. A tie is the only curve |
| F09 | Text directions in a bar | S | M | S | S | M | M | M | M | `Annotation` exists (import makes it) with no op; chord band only; MusicXML drops it |
| F10 | Whole-bar rests | S | S | S | S | S | S | S | S | Works (`rest add --dur 1`) |
| F11 | Ties | S | S | S | S | S | S | P | S | UI sets a tie on an existing note; it cannot add a note |
| F12 | Non-grid system breaks | P | P | P | S | - | M | M | M | `BARS_PER_SYSTEM` is 4 and a section forces a break; no way to say "five bars here" or let a section share a line |
| F13 | Style / tempo text | S | S | P | S | M | S | M | S | One small italic line, left under the title; MusicXML drops it; the rail now has a Title block (SIB2-178) |
| F14 | Free page text / copyright | M | M | M | M | M | M | M | M | No page-level text object |
| F15 | Segno, coda, D.S., D.C., Fine | S | S | S | S | S | S | S | S | ADR-0021 amended (SIB2-175): `Bar.nav`, `nav.set`/`nav.rm`, `<segno/>`/`<sound>` in MusicXML |
| F16 | Rehearsal and named boxes | S | S | S | S | P | S | S | S | Closed by SIB2-176: `Section.name` draws as a second box beside the letter (or alone). MusicXML keeps the letter only |
| F17 | Repeats | S | S | S | S | S | S | S | S | |
| F17b | 1st / 2nd endings | S | S | S | S | S | S | S | S | |
| F18 | N.C. | S | S | S | S | S | S | S | S | `N.C.` parses as a no-chord symbol; `(N.C.)` is flagged |
| F19 | Staccato, accent | M | M | M | M | M | M | M | M | |
| F20 | Fermata | M | M | M | M | M | M | M | M | |
| F21 | Ottava line | S | S | S | S | S | S | S | S | Closed by SIB2-184: `ottava.set`/`ottava.rm`, an `ottava` spanner, notes drawn shifted (stored sounding), `<octave-shift>` in MusicXML |
| F22 | Dashed continuation line | S | S | S | S | S | S | S | S | Closed by SIB2-170: `text set --until bar8`, `Annotation.lineEndBarId`, dashes + hook, `<dashes>` in MusicXML |
| F23 | Metronome mark | S | S | S | S | S | S | S | S | Closed by SIB2-177: `meta.tempo`, `meta set --tempo 4=120`, drawn above the first bar, `<sound tempo>` in MusicXML, a rail control |
| F24 | Extra title-block fields | M | M | M | M | P | M | M | M | `meta` has title, composer, style only |
| F25 | Empty staves at page bottom | - | - | S | S | - | S | S | S | Closed by SIB2-181: `export --blank-staves` (a page-spec choice, like page numbers), rail tick, same render in the browser |
| F26 | Parenthesised accidentals | S | S | S | S | S | S | S | M | Closed by SIB2-182: the `parens` display, `--accidental paren`, the inspector control, MusicXML `parentheses="yes"` |
| F27 | Grace notes | M | M | M | M | M | M | M | M | |
| F28 | Multi-staff system | M | M | M | M | M | M | M | M | Single staff and voice by design (ADR-0021); ADR-0039 d3 plans the model |
| F29 | Bass clef | M | M | M | M | M | M | M | M | `Clef = 'treble'` |
| F30 | Two voices | M | M | M | M | P | M | M | M | `note.add` refuses a second item at an onset; the codec drops a second voice with a note |
| F31 | Drum noteheads | M | M | M | M | M | M | M | M | |
| F32 | Pickup, double/final bars, key | S | S | S | S | S | S | S | S | |

## Ranked gaps, by pages that need them

Only features with at least one P or M cell. Ties in page count are ordered by how many layers are short.

| Rank | Gap | Pages | Layers short |
|---|---|---|---|
| 1 | Page numbers and page header/footer furniture (F01) | 7 | all |
| 2 | Parenthesised chord alterations parse and typeset (F04) | 5 | grammar, engraver, codec |
| 2 | Slash chords stacked, not inline (F05) | 5 | engraver |
| 4 | Slurs (F08) | 4 | all |
| 4 | Free page text: copyright, credits, closing instructions (F14) | 4 | all |
| 4 | Text directions: an op and a verb for `Annotation` (F09) | 4 | ops, CLI, UI, codec |
| 4 | Create and edit tuplets from ops, CLI and UI (F07) | 4 | ops, CLI, UI |
| 4 | Clef and key signature on the first system only (F03) | 4 | model, ops, layout, CLI, UI |
| 4 | Alternate chords in parentheses (F06) | 4 | grammar, engraver |
| 10 | System breaks that follow the original (F12) | 3 | layout, ops, CLI, UI |
| 10 | Navigation marks: segno, coda, D.S., D.C., Fine (F15) | 3 | all (an ADR-0021 reversal) |
| 10 | Named section boxes drawn (F16) | 3 | layout, engraver, codec |
| 10 | Style/tempo text placement and a UI control (F13) | 3 | layout, codec, UI |
| 14 | Articulations (F19) | 2 | all |
| 14 | Extra title-block fields (F24) | 2 | all but codec |
| 14 | Empty staves at page bottom (F25) | 2 | all |
| 14 | Parenthesised accidentals (F26) | 2 | engraver, CLI, UI |
| 18 | Tie entry in the UI (F11) | 7 benefit | UI |
| 19 | Fermata, ottava line, dashed continuation, metronome glyph (F20-F23) | 1 each | all |
| 19 | Multi-staff, bass clef, voices, drum noteheads (F28-F31) | 1 each | all (ADR-0039 d3) |
| 19 | Grace notes (F27) | 0 sure, 2 probable | all |

The lead-sheet furniture (page numbers, free text, system breaks) and chord text block the most pages.
The multi-staff intro is one page but touches every layer, which is why ADR-0039 decision 3 designs the
model first.

## Verified by running, and read from code

**Run against a local `sbscore serve` on a throwaway data directory, loopback only:**

- F04, F06, F18: chord texts typed through `chord set` and read back with `show`. `7(#11)`, `7(#5)`,
  `7(b5)`, `7(b9)`, `(Gmi7)`, `Bbmi(MA7)` and `(Gmi7 C7)` are flagged `!`; `C7#11`, `Cmi7`, `Ab-7`,
  `Ebmaj7`, `C13`, `F#o7`, `Cø`, `D7alt`, `Bb6/G` and `N.C.` are accepted.
- F07: a `tuplet.set` operation is refused (`no such operation`, exit 2); a `tuplet` object on `note.add`
  is accepted and ignored with no warning, which an agent cannot detect.
- F10, F13, F16: a PDF export was rasterised and looked at. A whole rest draws; the style line draws as
  small italic text left-aligned under the title; `--letter Intro` draws a boxed "Intro"; `--name Head`
  draws nothing.
- A layout defect found on the way: chord symbols at beats 1 and 3 of a bar holding one half note drew
  on top of each other. It is not a page feature; it is booked in the recreate pass (SIB2-149).
- F26: `sbscore --help` shows no accidental flag on `note add` or `note set`.

**Read from code, not run:** every model, layout and engraver cell for the features above
(`score.ts`, `operations.ts`, `layout/src/{grid,widths,layout}.ts`, `engrave/src/*`), the MusicXML
codec cells (`codec/src/{export,import}.ts` and their named lossy cases), the UI cells (the set of
`type:` ops the UI sends), and every MCP cell (V22 in `SLICES.md`; nothing is built).

**Not verified:** the `?` features; every FM, MO and MF reading, which is coarse by resolution; the
codec round trip of tuplets and ties.

## Recreate results (SIB2-149)

Each page was recreated, as far as the page allows, through `sbscore` against a local `serve` on a
throwaway data directory, exported through the real PDF path (`export --font jazz`) and compared with the
original by eye. Transcriptions stay outside the repository (ADR-0036); only features and card refs are
recorded here. Cards are filed under SIB2-E12 (SIB2-160 to SIB2-193).

| Page | What was recreated | Result |
|---|---|---|
| W | Pickup plus 8 of ~33 bars: key, meter, eighth and sixteenth runs, rests, a tie across a barline, chords with slash and half-diminished symbols, a double and a final barline | Pitches approximate. Triplet bar written straight (no op exists). Style, chord text and page differences below |
| S2 | 8 bars: rehearsal letter, accidentals with no key signature, a whole note, double bar | Free-text directions, ottava text, articulations and a triplet not expressible |
| LJ | Structure only, 17 bars: Intro and A and B boxes, repeat, 1st/2nd endings, N.C., 20 chords. Melody left as rests | Intro cannot share a line with A; no "HEAD" box, segno, D.S., tempo, header or footer text |
| S1 | Not started. The first system needs a second staff, a bass clef and a drum staff, and the first operation fails at "add a staff". The head (from the rehearsal letter on) is the same material as S2 | Blocked by the model (SIB2-151) |
| GE, FM, MO, MF | Not transcribed. 230 to 490 px wide: pitches and most chord symbols cannot be read reliably, so none were invented. Their structure features (repeat, endings, pickup, whole-bar rests) are the same operations proven on W and LJ | Low resolution; not attempted |

### Operations that cannot be expressed

Tuplet (SIB2-166), slur (167, 168), text direction (169), dashed line (170), page number (171), footer and
credit text (172), first-system-only signatures (173), line breaks (174), segno/D.S./D.C./Fine (175),
section name box (176), tempo glyph (177), articulation (179), subtitle and arranger (180), blank staves
(181), parenthesised accidental (182), fermata (183), ottava (184), grace note (185), second staff, clef
and voice (SIB2-151).

### Visual differences found by looking at the renders

- A major-seventh chord exports without its quality mark: `Ebmaj7` prints as `Eb7` in the PDF
  (SIB2-162). Verified with `pdftotext`; the font has no glyph for it.
- Two chord symbols over a bar with one item draw on top of each other (SIB2-165).
- `-7` prints as `m7` and `G-7b5` prints as the half-diminished circle; the page's own symbology is not
  selectable (SIB2-163). Chord text and the title are serif (SIB2-40).
- Slash chords draw inline, not stacked (SIB2-164); parenthesised alterations and alternates draw as
  flagged plain text (SIB2-160, SIB2-161).
- A whole-bar rest sits at the left of its bar rather than centred (SIB2-192).
- Bar numbers print at each system start where the originals have none: closed by SIB2-191 (`export --no-bar-numbers`, a rail tick).
- The intro bar is alone on its line; the original shares a line with the first section (SIB2-174).

### How agent-friendly the CLI was

What worked: one `batch` applied 88 operations as one undoable version; addresses like `bar3.beat2.5`
were easy to generate; the out-of-range bar error lists the valid bars; `show` made a read-back possible.
What got in the way, each a card:

- No way to add a bar after `new --bars N` (SIB2-186).
- `batch --ops` takes only inline JSON; 88 operations were a 10 KB argument (SIB2-187).
- An unknown payload field (`tuplet` on `note.add`) is accepted and ignored (SIB2-188).
- `barline set <id> 2` fails; usage says `<bar>` but only `bar2` works (SIB2-189).
- No raster or SVG export, so the agent cannot look at its result without an outside tool: SVG closed by SIB2-190 (`export --svg`, one file per page, the browser's own markup); PNG is deliberately not built, since no rasteriser ships in a product bundle (ADR-0031).
- A chord typo (`E07` for `Eo7`) only shows as a `!` flag in `show`; reading flags back is the only
  signal, and there is no verb that lists every flagged object at once (SIB2-193).

### Ranking after the recreate pass

The page counts above stand. The recreate pass adds two defects that affect every page with a
major-seventh or a sparse bar (SIB2-162, SIB2-165), which makes them the cheapest wins; the largest
unbuilt blocks stay page furniture (SIB2-171, SIB2-172), slurs (SIB2-167, SIB2-168), tuplets
(SIB2-166) and line breaks (SIB2-174).

### Verified by running (additions)

Everything in this section was run: the batch, the exports and the renders for W, S2 and LJ, the
`pdftotext` and `pdffonts` checks, and the CLI errors quoted. Not run: the browser, MusicXML export of the
recreated pages, and any MCP call.
