import { allStaves, barViews } from '@sibei/model';
import type { Score } from '@sibei/model';
import { describe, expect, it } from 'vitest';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';

/**
 * ADR-0041 slice 5a (SIB2-229): reading multi-part files from elsewhere, and the untrusted-input bounds that keep
 * a hostile one cheap (SIB2-152). The round trip of our own fixtures is in `musicxml-multistaff.test.ts`.
 */

describe('a multi-part file from elsewhere', () => {
  const doc = (parts: string, list = '<part-list><score-part id="P1"/><score-part id="P2"/></part-list>'): string =>
    `<?xml version="1.0"?><score-partwise version="4.0">${list}${parts}</score-partwise>`;
  const n = (step: string, extra = '', duration = 4, octave = 4): string =>
    `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration><type>quarter</type>${extra}</note>`;
  const attrs = (inner = ''): string =>
    `<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time>${inner}</attributes>`;
  const measure = (body: string, number = 1): string => `<measure number="${number}">${body}</measure>`;
  const part = (id: string, ...measures: string[]): string => `<part id="${id}">${measures.join('')}</part>`;
  const items = (score: Score, staff: number, voice: number, bar = 0): string[] =>
    barViews(score, { staff: allStaves(score)[staff - 1]?.id as string, voice })[bar]!.items.map((item) =>
      item.kind === 'note' ? `${item.pitch.step}@${item.onset}` : `rest@${item.onset}`,
    );

  it('reads staves, voices numbered per staff, backups and forwards', () => {
    const body =
      n('C', '<voice>1</voice><staff>1</staff>') +
      '<forward><duration>4</duration></forward>' +
      n('E', '<voice>1</voice><staff>1</staff>') +
      '<backup><duration>12</duration></backup>' +
      n('G', '<voice>2</voice><staff>1</staff>', 8) +
      '<backup><duration>8</duration></backup>' +
      // Staff 2 numbers its voice 1 again: a per-staff numbering, not this codec's.
      n('C', '<voice>1</voice><staff>2</staff>', 16, 3);
    const { score, warnings } = musicXmlToScore(doc(part('P1', measure(attrs('<staves>2</staves>') + body))));
    expect(warnings).toEqual([]);
    expect(items(score, 1, 1)).toEqual(['C@0', 'E@960']);
    expect(items(score, 1, 2)).toEqual(['G@0']);
    expect(items(score, 2, 1)).toEqual(['C@0']);
    expect(score.meta.layout).toBe('score');
  });

  it('keeps chords above the top staff from the first part only', () => {
    const harmony = '<harmony><root><root-step>C</root-step></root><kind text="C">major</kind></harmony>';
    const { score } = musicXmlToScore(
      doc(part('P1', measure(attrs() + harmony + n('C'))) + part('P2', measure(attrs() + harmony + n('E')))),
    );
    expect(score.harmony[0]?.chords).toHaveLength(1);
    expect(score.parts).toHaveLength(2);
  });

  it('reads a later part with more or fewer measures than the first', () => {
    const more = musicXmlToScore(
      doc(part('P1', measure(attrs() + n('C'))) + part('P2', measure(attrs() + n('E')), measure(n('F'), 2))),
    );
    expect(more.warnings.join('|')).toContain('measures after bar 1 of a later part were dropped');
    const fewer = musicXmlToScore(
      doc(part('P1', measure(attrs() + n('C')), measure(n('D'), 2)) + part('P2', measure(attrs() + n('E')))),
    );
    expect(fewer.score.bars).toHaveLength(2);
    expect(items(fewer.score, 2, 1, 1)).toEqual([]);
  });

  it('reads an alto clef, a clef change and a percussion staff', () => {
    const drum =
      '<note><unpitched><display-step>F</display-step><display-octave>5</display-octave></unpitched><duration>4</duration><type>quarter</type></note>';
    const { score } = musicXmlToScore(
      doc(
        part(
          'P1',
          measure(attrs('<clef><sign>C</sign><line>3</line></clef>') + n('C')),
          measure('<attributes><clef><sign>F</sign><line>4</line></clef></attributes>' + n('D'), 2),
        ) + part('P2', measure(attrs('<clef><sign>percussion</sign></clef>') + drum)),
      ),
    );
    expect(score.parts[0]?.staves[0]?.clef).toBe('alto');
    expect(score.parts[0]?.staves[0]?.bars[1]?.clef).toBe('bass');
    expect(score.parts[1]?.staves[0]).toMatchObject({ type: 'percussion', clef: 'percussion' });
    expect(items(score, 2, 1)).toEqual(['F@0']);
  });
});

describe('hostile multi-part input is bounded', () => {
  const run = (body: string, parts = 1, inner = ''): ReturnType<typeof musicXmlToScore> =>
    musicXmlToScore(
      `<score-partwise><part-list/>` +
        Array.from(
          { length: parts },
          (_, i) =>
            `<part id="P${i + 1}"><measure number="1"><attributes><divisions>1</divisions>${inner}</attributes>${body}</measure></part>`,
        ).join('') +
        `</score-partwise>`,
    );
  const q = (extra = ''): string =>
    `<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type>${extra}</note>`;

  it('treats a nonsense staff number as staff 1 and a huge one as dropped', () => {
    expect(run(q('<staff>-3</staff>') + q('<staff>x</staff>')).score.parts[0]?.staves).toHaveLength(1);
    const huge = run(q('<staff>2000000000</staff>') + q());
    expect(huge.score.parts[0]?.staves).toHaveLength(1);
    expect(huge.warnings.join('|')).toContain('staves past the 8th');
  });

  it('caps the distinct voice numbers on one staff', () => {
    const many = Array.from({ length: 400 }, (_, i) => q(`<voice>v${i}</voice>`)).join('');
    const result = run(many);
    expect(result.warnings.join('|')).toContain('voices past the 16th number');
    expect(result.warnings.join('|')).toContain('voices past the 4th on a staff were dropped');
    expect(result.score.parts[0]?.staves[0]?.bars[0]?.voices.length).toBeLessThanOrEqual(4);
  });

  it('survives absurd durations, backups and pitches', () => {
    const body =
      '<forward><duration>1e308</duration></forward><backup><duration>99999999999</duration></backup>' +
      '<note><pitch><step>Z</step><octave>1000000000</octave></pitch><duration>-5</duration><type>quarter</type></note>' +
      '<note><pitch><step>C</step><octave>4</octave></pitch><duration>Infinity</duration></note>';
    const { score } = run(body);
    const first = barViews(score)[0]!.items;
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({ pitch: { step: 'C', octave: 10 } });
  });

  it('drops an absurd transposition and survives an extreme one', () => {
    const huge = run(q(), 1, '<transpose><chromatic>400</chromatic></transpose>');
    expect(huge.score.parts[0]?.transposition).toBe(0);
    expect(huge.warnings.join('|')).toContain('transposition of more than three octaves');
    const edge = run(q(), 1, '<transpose><diatonic>-20</diatonic><chromatic>-35</chromatic></transpose>');
    expect(() => scoreToMusicXml(edge.score)).not.toThrow();
  });

  it('survives many empty parts and a part with no measures', () => {
    expect(run('', 31).score.parts).toHaveLength(31);
    const none = musicXmlToScore(
      `<score-partwise><part id="P1"><measure number="1">${q()}</measure></part><part id="P2"/></score-partwise>`,
    );
    expect(none.score.parts).toHaveLength(2);
    expect(none.score.parts[1]?.staves[0]?.bars).toHaveLength(1);
  });
});
