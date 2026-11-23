import { describe, expect, it } from 'vitest';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { pianoChordsChart, stackedChordsChart } from '@sibei/fixtures';
import { barViews, chordTones, scoreMetrics, voiceSelects } from '@sibei/model';
import type { Score } from '@sibei/model';

/** Stacked chords in MusicXML (SIB2-243): `<chord/>` notes both ways, replacing the old "chord tones dropped" case. */

const pitchesOf = (score: Score, bar: number, n: number, select = voiceSelects(score)[0]): string[] => {
  const item = barViews(score, select)[bar - 1]?.items[n - 1];
  if (item?.kind !== 'note') throw new Error('no note');
  return chordTones(item).map((tone) => `${tone.pitch.step}${tone.pitch.alter === 0 ? '' : tone.pitch.alter > 0 ? '#' : 'b'}${tone.pitch.octave}`);
};

describe('export', () => {
  it('writes the carrying note then a <chord/> note per other pitch, with the same duration', () => {
    const xml = scoreToMusicXml(stackedChordsChart());
    // Bar 1's first chord: C4 E4 G4 is three notes, two of them `<chord/>`.
    const firstMeasure = xml.slice(xml.indexOf('<measure'), xml.indexOf('</measure>'));
    const notes = firstMeasure.split('<note>').slice(1, 4);
    expect(notes[0]).not.toContain('<chord');
    expect(notes[1]).toContain('<chord/>');
    expect(notes[2]).toContain('<chord/>');
    const durations = notes.map((note) => /<duration>(\d+)<\/duration>/.exec(note)?.[1]);
    expect(new Set(durations).size).toBe(1);
  });

  it('writes a tie on the pitch that carries it', () => {
    const xml = scoreToMusicXml(stackedChordsChart());
    // Bar 6 ties C4 and G4 only: two `tie start` in the measure, not three.
    const sixth = xml.split('<measure ')[6] ?? '';
    expect((sixth.match(/<tie type="start"\/>/g) ?? []).length).toBe(2);
  });
});

describe('round trip', () => {
  it('keeps every chord, its pitches and its ties, and counts a chord once in the bar', () => {
    const original = stackedChordsChart();
    const { score, warnings } = musicXmlToScore(scoreToMusicXml(original), { id: 'rt' });
    expect(warnings).toEqual([]);
    for (const [bar, n] of [[1, 1], [2, 1], [2, 4], [3, 1], [3, 2], [4, 1], [5, 4], [6, 1]] as const) {
      expect(pitchesOf(score, bar, n)).toEqual(pitchesOf(original, bar, n));
    }
    const sixth = barViews(score)[5]?.items[0];
    expect(sixth?.kind === 'note' ? chordTones(sixth).map((t) => t.tie) : []).toEqual(
      chordTones(barViews(original)[5]!.items[0] as never).map((t) => t.tie),
    );
    expect(scoreMetrics(score).every((m) => m.valid)).toBe(true);
  });

  it('keeps a grand staff of chords, with a second voice', () => {
    const original = pianoChordsChart();
    const { score, warnings } = musicXmlToScore(scoreToMusicXml(original), { id: 'rt' });
    expect(warnings).toEqual([]);
    const [rhOriginal, lhOriginal] = [voiceSelects(original)[0], voiceSelects(original).at(-1)];
    const [rh, lh] = [voiceSelects(score)[0], voiceSelects(score).at(-1)];
    expect(pitchesOf(score, 1, 1, lh)).toEqual(pitchesOf(original, 1, 1, lhOriginal));
    expect(pitchesOf(score, 1, 1, rh)).toEqual(pitchesOf(original, 1, 1, rhOriginal));
    expect(voiceSelects(score)).toHaveLength(voiceSelects(original).length);
  });
});

describe('import', () => {
  const wrap = (body: string): string =>
    `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>x</part-name></score-part></part-list>` +
    `<part id="P1"><measure number="1"><attributes><divisions>480</divisions><key><fifths>0</fifths></key>` +
    `<time><beats>4</beats><beat-type>4</beat-type></time></attributes>${body}</measure></part></score-partwise>`;
  const n = (step: string, octave: number, extra = ''): string =>
    `<note>${extra}<pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>480</duration><type>quarter</type></note>`;

  it('joins a <chord/> note to the note before it, in any order, and drops nothing', () => {
    const { score, warnings } = musicXmlToScore(wrap(n('G', 4) + n('C', 4, '<chord/>') + n('E', 4, '<chord/>') + n('A', 4)));
    expect(warnings).toEqual([]);
    expect(barViews(score)[0]?.items).toHaveLength(2);
    expect(pitchesOf(score, 1, 1)).toEqual(['C4', 'E4', 'G4']);
  });
});
