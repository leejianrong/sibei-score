import type { BarView, Score } from '@sibei/model';
import { createIdFactory, dur, makeScore, makeStaffedScore, parseLyricText, voiceOfView } from '@sibei/model';
import { BarBuilder } from './builder.js';
import type { BarSpec } from './builder.js';

/**
 * The lyrics proofing charts (SIB2-273, ADR-0021 amendment). Synthetic words, written the way `lyrics set` reads them.
 *
 * `lyricsChart`, eight bars on two lines:
 * - bars 1-2: a verse of whole words and a hyphenated word that runs across the barline
 * - bar 3: a melisma (`_`), an extender line over two held notes, then a rest the verse skips
 * - bar 4 into bar 5: a word begun at the end of the first line and ended on the second, so its hyphen trails at the
 *   system edge
 * - bars 5-6: beamed eighth notes with a syllable each, and a tied note that takes none
 * - bars 7-8: a second verse under the first, the two rows stacked, ending on a long held syllable
 *
 * `lyricsStavesChart`: a grand staff whose upper (vocal) staff carries two verses, so the rows sit between the staves.
 */
type Slot = BarView['items'][number];

/** Lay `text` over the notes of `bars` as `lyrics.set` does: rests and tied-on notes take no syllable. */
function sing(bars: BarView[], text: string, verse: number): void {
  const parsed = parseLyricText(text);
  if (!parsed.ok) throw new Error(parsed.detail);
  const notes: Slot[] = bars.flatMap((bar) =>
    bar.items.filter((item) => item.kind === 'note' && item.tie !== 'stop' && item.tie !== 'both'),
  );
  if (parsed.slots.length > notes.length) throw new Error(`${parsed.slots.length} syllables for ${notes.length} notes`);
  parsed.slots.forEach((slot, index) => {
    const note = notes[index];
    if (note === undefined || note.kind !== 'note' || slot.skip) return;
    note.lyrics = [...(note.lyrics ?? []), { verse, text: slot.text, syllabic: slot.syllabic, ...(slot.extend === true ? { extend: true as const } : {}) }];
  });
}

export function lyricsChart(): Score {
  const ids = createIdFactory();
  const make = (spec: BarSpec): BarBuilder => new BarBuilder(ids, spec);
  const bars: BarView[] = [
    make({ number: 1 }).chord(1, 'Cmaj7', 480).note('E5', dur(4)).note('G5', dur(4)).note('E5', dur(4)).note('C5', dur(4)).build(),
    make({ number: 2 }).chord(1, 'Am7', 480).note('D5', dur(4)).note('F5', dur(4)).note('E5', dur(2)).build(),
    make({ number: 3 }).chord(1, 'Dm7', 480).note('F5', dur(2)).note('E5', dur(4)).note('D5', dur(8)).rest(dur(8)).build(),
    make({ number: 4 }).chord(1, 'G7', 480).note('D5', dur(4)).note('B4', dur(4)).note('C5', dur(4)).note('D5', dur(4)).build(),
    make({ number: 5 }).chord(1, 'Cmaj7', 480).note('E5', dur(8)).note('F5', dur(8)).note('G5', dur(8)).note('F5', dur(8)).note('E5', dur(4)).note('D5', dur(4)).build(),
    make({ number: 6 }).chord(1, 'Am7', 480).note('C5', dur(2), 'start').note('C5', dur(4), 'stop').note('D5', dur(4)).build(),
    make({ number: 7 }).chord(1, 'Dm7', 480).note('F5', dur(4)).note('E5', dur(4)).note('D5', dur(4)).note('C5', dur(4)).build(),
    make({ number: 8, endBarline: 'final' }).chord(1, 'Cmaj7', 480).note('C5', dur(1)).build(),
  ];
  // `so _` holds bar 3's first note over the next (the extender), and `ten-der` straddles the system break.
  sing(bars, 'Ho-ly mo-ments fill the air so _ sweet and soft glow ten-der eyes beam-ing bright for you to-night we sing a-long', 1);
  sing(bars.slice(0, 2), 'Sun-light on the hill', 2);
  sing(bars.slice(6), 'Fall-ing fall-ing home', 2);
  const score = makeScore({ id: 'lyrics-chart', title: 'Lyrics', composer: 'Proof chart', bars });
  return score;
}

export function lyricsStavesChart(): Score {
  const ids = createIdFactory();
  const make = (spec: BarSpec): BarBuilder => new BarBuilder(ids, spec);
  const right: BarView[] = [
    make({ number: 1 }).chord(1, 'C', 480).note('E5', dur(4)).note('G5', dur(4)).note('E5', dur(4)).note('C5', dur(4)).build(),
    make({ number: 2, endBarline: 'final' }).chord(1, 'G7', 480).note('D5', dur(2)).note('B4', dur(2)).build(),
  ];
  const left: BarView[] = [
    make({ number: 1 }).note('C3', dur(2)).note('G2', dur(2)).build(),
    make({ number: 2, endBarline: 'final' }).note('G2', dur(2)).note('D3', dur(2)).build(),
  ];
  sing(right, 'Just a lit-tle night song', 1);
  sing(right, 'Soft-ly soft-ly now', 2);
  return makeStaffedScore({
    id: 'lyrics-staves',
    title: 'Lyrics on staves',
    composer: 'Proof chart',
    bars: right,
    parts: [
      {
        name: 'Piano',
        instrument: 0,
        staves: [
          { clef: 'treble', bars: right.map((view) => voiceOfView(view)) },
          { clef: 'bass', bars: left.map((view) => voiceOfView(view)) },
        ],
      },
    ],
  });
}
