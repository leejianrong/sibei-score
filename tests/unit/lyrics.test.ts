import { describe, expect, it } from 'vitest';
import { applyOperation, replay } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { lyricsChart, lyricsStavesChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import { barViews, dur, formatSyllable, orderedItems, parseLyricText, projectScore, splitSyllable } from '@sibei/model';
import type { Score } from '@sibei/model';

/** Lyrics (SIB2-273, ADR-0021 amendment): the text reader, the ops, the projection, layout and MusicXML. */

function run(operations: Operation[]): { score: Score; log: Operation[] } {
  const log: Operation[] = [];
  let score: Score | null = null;
  for (const operation of operations) {
    const applied = applyOperation(score, operation);
    score = applied.score;
    log.push(applied.operation);
  }
  if (score === null) throw new Error('no score');
  return { score, log };
}

const q = dur(4);
const note = (target: string, pitch: string, tie?: 'start' | 'stop'): Operation => ({
  type: 'note.add',
  target,
  payload: { pitch, duration: q, ...(tie === undefined ? {} : { tie }) },
});
const base: Operation[] = [
  { type: 'score.create', payload: { id: 'song', barCount: 2 } },
  note('bar1.beat1', 'C5'),
  note('bar1.beat2', 'D5'),
  { type: 'rest.add', target: 'bar1.beat3', payload: { duration: q } },
  note('bar1.beat4', 'E5'),
  note('bar2.beat1', 'F5'),
  note('bar2.beat2', 'G5'),
];
const lyricsOf = (score: Score, bar: number): string[] =>
  orderedItems(barViews(score)[bar - 1]!).map((item) => (item.kind === 'note' ? (item.lyrics ?? []).map((l) => `${l.verse}:${formatSyllable(l)}${l.extend === true ? '_' : ''}`).join(' ') : '-'));

describe('the text reader', () => {
  it('splits words by spaces and syllables by hyphens, with or without spaces around the hyphen', () => {
    const plain = parseLyricText('hel-lo a-long the');
    const spaced = parseLyricText('hel - lo a - long the');
    expect(plain).toEqual(spaced);
    expect(plain.ok && plain.slots.map((slot) => (slot.skip ? '_' : `${slot.text}/${slot.syllabic}`))).toEqual([
      'hel/begin',
      'lo/end',
      'a/begin',
      'long/end',
      'the/single',
    ]);
  });

  it('reads three syllables of a word as begin, middle, end, and _ as a held note that extends the one before', () => {
    const parsed = parseLyricText('won-der-ful la _ _');
    expect(parsed.ok && parsed.slots).toEqual([
      { skip: false, text: 'won', syllabic: 'begin' },
      { skip: false, text: 'der', syllabic: 'middle' },
      { skip: false, text: 'ful', syllabic: 'end' },
      { skip: false, text: 'la', syllabic: 'single', extend: true },
      { skip: true },
      { skip: true },
    ]);
  });

  it('refuses empty text and a syllable past the bound; splits a lone syllable by its hyphens', () => {
    expect(parseLyricText('   ').ok).toBe(false);
    expect(parseLyricText('x'.repeat(41)).ok).toBe(false);
    expect([splitSyllable('hel-'), splitSyllable('-lo'), splitSyllable('-l-'), splitSyllable('la')].map((s) => s.syllabic)).toEqual([
      'begin',
      'end',
      'middle',
      'single',
    ]);
  });
});

describe('lyric.set and lyric.rm', () => {
  it('sets a syllable, reads its position from the hyphens, keeps verses in order, replays, and removes', () => {
    const set: Operation[] = [
      { type: 'lyric.set', target: 'bar1.n1', payload: { text: 'hel-' } },
      { type: 'lyric.set', target: 'bar1.n1', payload: { text: 'la', verse: 2, extend: true } },
      { type: 'lyric.set', target: 'bar1.n2', payload: { text: '-lo' } },
    ];
    const on = run([...base, ...set]);
    expect(lyricsOf(on.score, 1)).toEqual(['1:hel- 2:la_', '1:-lo', '-', '']);
    expect(replay(on.log)).toEqual(on.score);
    const swapped = run([...on.log, { type: 'lyric.set', target: 'bar1.n1', payload: { text: 'mi', verse: 1 } }]);
    expect(lyricsOf(swapped.score, 1)[0]).toBe('1:mi 2:la_');
    const one = run([...on.log, { type: 'lyric.rm', target: 'bar1.n1', payload: { verse: 1 } }]);
    expect(lyricsOf(one.score, 1)[0]).toBe('2:la_');
    const all = run([...on.log, { type: 'lyric.rm', target: 'bar1.n1' }]);
    expect('lyrics' in (barViews(all.score)[0]!.items[0] as object)).toBe(false);
  });

  it('refuses a rest, a fifth verse, empty text, and removing what is not there', () => {
    expect(() => run([...base, { type: 'lyric.set', target: 'bar1.n3', payload: { text: 'la' } }])).toThrow();
    expect(() => run([...base, { type: 'lyric.set', target: 'bar1.n1', payload: { text: 'la', verse: 5 } }])).toThrow(/verse/);
    expect(() => run([...base, { type: 'lyric.set', target: 'bar1.n1', payload: { text: ' ' } }])).toThrow(/needs text/);
    expect(() => run([...base, { type: 'lyric.rm', target: 'bar1.n1' }])).toThrow(/nothing to remove/);
  });

  it('a chart without lyrics has no lyrics field and reserves no lyric row', () => {
    const { score } = run(base);
    expect(JSON.stringify(score)).not.toContain('lyrics');
    const system = layout(score).pages[0]!.systems[0]!;
    expect(system.lyricOffset).toBeUndefined();
    expect(system.lyricLinks).toBeUndefined();
  });
});

describe('lyrics.set', () => {
  it('distributes a verse over a bar range, skipping rests, and replaces that verse only', () => {
    const first = run([...base, { type: 'lyrics.set', payload: { first: 1, last: 2, text: 'Hel-lo my sweet' } }]);
    expect(lyricsOf(first.score, 1)).toEqual(['1:Hel-', '1:-lo', '-', '1:my']);
    expect(lyricsOf(first.score, 2)).toEqual(['1:sweet', '']);
    expect(replay(first.log)).toEqual(first.score);
    // A second verse stacks; redoing verse 1 over the range replaces only verse 1.
    const second = run([
      ...first.log,
      { type: 'lyrics.set', payload: { first: 1, last: 1, text: 'Sun', verse: 2 } },
      { type: 'lyrics.set', payload: { first: 1, last: 2, text: 'No more' } },
    ]);
    expect(lyricsOf(second.score, 1)).toEqual(['1:No 2:Sun', '1:more', '-', '']);
    expect(lyricsOf(second.score, 2)).toEqual(['', '']);
  });

  it('gives a note tied from the one before it no syllable, and _ holds a note with an extender', () => {
    const tied = run([
      { type: 'score.create', payload: { id: 'song', barCount: 1 } },
      note('bar1.beat1', 'C5', 'start'),
      note('bar1.beat2', 'C5', 'stop'),
      note('bar1.beat3', 'D5'),
      note('bar1.beat4', 'E5'),
      { type: 'lyrics.set', payload: { first: 1, last: 1, text: 'la _ ti' } },
    ]);
    expect(lyricsOf(tied.score, 1)).toEqual(['1:la_', '', '', '1:ti']);
  });

  it('refuses more syllables than notes with both counts, an unknown staff or voice, and a bad range or verse', () => {
    expect(() => run([...base, { type: 'lyrics.set', payload: { first: 1, last: 1, text: 'a b c d e f g' } }])).toThrow(/7 syllables for 3 notes/);
    expect(() => run([...base, { type: 'lyrics.set', payload: { staff: 's9', first: 1, last: 1, text: 'a' } }])).toThrow(/staff/);
    expect(() => run([...base, { type: 'lyrics.set', payload: { voice: 2, first: 1, last: 1, text: 'a' } }])).toThrow(/voice/);
    expect(() => run([...base, { type: 'lyrics.set', payload: { first: 2, last: 1, text: 'a' } }])).toThrow(/first not after last/);
    expect(() => run([...base, { type: 'lyrics.set', payload: { first: 1, last: 1, text: 'a', verse: 0 } }])).toThrow(/verse/);
  });

  it('is removed with its note', () => {
    const { score } = run([...base, { type: 'lyrics.set', payload: { first: 1, last: 2, text: 'a b c d' } }, { type: 'note.rm', target: 'bar1.n1' }]);
    expect(JSON.stringify(score)).not.toContain('"a"');
  });
});

describe('the projection', () => {
  it('prints the syllable after the note, with its hyphens, an extender and a verse number from verse 2', () => {
    const { score } = run([
      ...base,
      { type: 'lyric.set', target: 'bar1.n1', payload: { text: 'hel-' } },
      { type: 'lyric.set', target: 'bar1.n1', payload: { text: 'la', verse: 2, extend: true } },
    ]);
    expect(projectScore(score)).toContain('c5/4"hel-"2"la"_');
  });
});

describe('layout', () => {
  it('reserves one row per verse in use, only where there are lyrics, and plans hyphens across the system break', () => {
    const systems = layout(lyricsChart()).pages[0]!.systems;
    expect(systems.map((system) => system.lyricVerses)).toEqual([2, 2]);
    expect(systems.every((system) => system.belowStaff >= system.lyricOffset! + 4)).toBe(true);
    const links = systems.flatMap((system) => system.lyricLinks ?? []);
    // `ten-der` straddles the break: its hyphen trails on the first system (no next syllable there).
    const trailing = (systems[0]!.lyricLinks ?? []).filter((link) => link.kind === 'hyphen' && link.toNoteId === null);
    expect(trailing).toHaveLength(1);
    expect(links.filter((link) => link.kind === 'extend')).toHaveLength(1);
  });

  it('gives the upper staff of a grand staff its own lyric rows', () => {
    const system = layout(lyricsStavesChart()).pages[0]!.systems[0]!;
    expect(system.staves!.map((staff) => staff.lyricVerses)).toEqual([2, undefined]);
  });
});

describe('MusicXML', () => {
  it('round trips every syllable, verse and extender of the lyrics chart, with no warning', () => {
    const original = lyricsChart();
    const xml = scoreToMusicXml(original);
    expect(xml).toMatch(/<syllabic>begin<\/syllabic>/);
    expect(xml).toMatch(/<extend\/>/);
    const { score, warnings } = musicXmlToScore(xml, { id: original.id });
    expect(warnings).toEqual([]);
    expect(lyricsOf(score, 3)).toEqual(lyricsOf(original, 3));
    for (let bar = 1; bar <= 8; bar += 1) expect(lyricsOf(score, bar)).toEqual(lyricsOf(original, bar));
  });

  it('keeps the lyrics of the upper staff of a grand staff', () => {
    const original = lyricsStavesChart();
    const { score, warnings } = musicXmlToScore(scoreToMusicXml(original), { id: original.id });
    expect(warnings).toEqual([]);
    expect(lyricsOf(score, 1)).toEqual(lyricsOf(original, 1));
  });

  it('names a lyric it cannot keep: a ninth verse, a second syllable for a verse, no text', () => {
    const xml = scoreToMusicXml(lyricsChart());
    expect(musicXmlToScore(xml.replace('<lyric number="1">', '<lyric number="9">'), { id: 'x' }).warnings.join('|')).toContain('verse 9');
    expect(musicXmlToScore(xml.replace('<text>Ho</text>', '<humming/>'), { id: 'x' }).warnings.join('|')).toContain('no text');
  });
});
