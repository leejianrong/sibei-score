import { barViews } from '@sibei/model';
import { describe, expect, it } from 'vitest';
import { ImportError, musicXmlToScore, parseXml, scoreToMusicXml, XmlError } from '@sibei/codec';
import { FIXTURE_REGISTRY } from '@sibei/fixtures';

/**
 * SIB2-152. The importer reads untrusted files, so its refusals and its lossy cases are both decisions on
 * record: hostile XML is bounded (nesting, entities, code points), every fixture survives export then import,
 * and everything the codec cannot keep is *named* in `warnings` rather than silently thinned.
 */

const wrap = (measureBody: string, extra = '', parts = 1): string =>
  `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"/></part-list>` +
  Array.from(
    { length: parts },
    (_, i) =>
      `<part id="P${i + 1}"><measure number="1"><attributes><divisions>1</divisions>${extra}<time><beats>4</beats><beat-type>4</beat-type></time></attributes>${measureBody}</measure></part>`,
  ).join('') +
  `</score-partwise>`;
const note = (extra = ''): string =>
  `<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type>${extra}</note>`;

function failure(xml: string): ImportError | undefined {
  try {
    musicXmlToScore(xml);
  } catch (error) {
    return error as ImportError;
  }
  return undefined;
}

describe('hostile XML is bounded', () => {
  it('refuses nesting past the cap with an XmlError, not a stack overflow', () => {
    const deep = '<a>'.repeat(5000) + '</a>'.repeat(5000);
    expect(() => parseXml(deep)).toThrow(XmlError);
    expect(failure(deep)).toBeInstanceOf(ImportError);
  });

  it('never expands a declared entity (billion laughs stays inert)', () => {
    const laughs =
      `<?xml version="1.0"?><!DOCTYPE score-partwise [<!ENTITY a "AAAAAAAAAA"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>` +
      `<score-partwise><work><work-title>&b;</work-title></work><part><measure number="1">${note()}</measure></part></score-partwise>`;
    expect(musicXmlToScore(laughs).score.meta.title).toBe('&b;');
  });

  it('does not throw on an out-of-range character reference', () => {
    const xml = wrap(note()).replace('<part-list>', '<work><work-title>x&#99999999999;y</work-title></work><part-list>');
    expect(() => musicXmlToScore(xml)).not.toThrow();
  });

  it('refuses score-timewise as unsupported, and other garbage as malformed', () => {
    expect(failure('<score-timewise/>')?.kind).toBe('unsupported');
    expect(failure('<html/>')?.kind).toBe('malformed');
    expect(failure('not xml at all')?.kind).toBe('malformed');
  });
});

describe('every lossy case is named in the warnings', () => {
  const warnings = (xml: string): string[] => musicXmlToScore(xml).warnings;

  it('parts and staves are kept, not dropped (ADR-0041 slice 5a)', () => {
    const result = musicXmlToScore(wrap(note(), '', 3));
    expect(result.score.parts).toHaveLength(3);
    expect(result.warnings).toEqual([]);
    const staves = musicXmlToScore(wrap(note() + note('<staff>2</staff>'), '<staves>2</staves>'));
    expect(staves.score.parts[0]?.staves).toHaveLength(2);
    expect(staves.warnings).toEqual([]);
  });
  it('parts and staves past the bounds', () => {
    expect(warnings(wrap(note(), '', 40)).join('|')).toContain('further parts dropped: a score reads at most 32 parts');
    expect(musicXmlToScore(wrap(note(), '', 40)).score.parts).toHaveLength(32);
    expect(warnings(wrap(note('<staff>9</staff>'), '<staves>12</staves>')).join('|')).toContain('staves past the 8th of a part');
    expect(warnings(wrap(note(), '<staves>8</staves>', 6)).join('|')).toContain('further parts dropped');
  });
  it('lyrics', () => expect(warnings(wrap(note('<lyric><text>la</text></lyric>')))).toContain('lyrics were dropped'));
  it('dynamics', () =>
    expect(warnings(wrap('<direction><direction-type><dynamics><f/></dynamics></direction-type></direction>' + note()))).toContain(
      'dynamics were dropped',
    ));
  it('grace notes are read onto the note after them (SIB2-185), not dropped', () => {
    const grace = '<note><grace/><pitch><step>D</step><octave>4</octave></pitch><type>eighth</type></note>';
    const result = musicXmlToScore(wrap(grace + note()));
    expect(result.warnings).toEqual([]);
    expect(barViews(result.score)[0]!.items).toHaveLength(1);
    const first = barViews(result.score)[0]!.items[0];
    expect(first?.kind === 'note' ? first.graces?.length : 0).toBe(1);
  });
  it('a grace note with no note after it is dropped with a warning', () => {
    const grace = '<note><grace/><pitch><step>D</step><octave>4</octave></pitch><type>eighth</type></note>';
    const result = musicXmlToScore(wrap(note() + grace));
    expect(result.warnings).toContain('grace notes with no note after them were dropped');
  });
  it('a fifth voice, and a chord note that repeats a pitch (SIB2-243: a chord note is read as a stacked chord)', () => {
    const voices = [1, 2, 3, 4, 5].map((v) => note(`<voice>${v}</voice>`)).join('<backup><duration>4</duration></backup>');
    expect(warnings(wrap(voices))).toContain('voices past the 4th on a staff were dropped');
    expect(warnings(wrap(note() + note('<chord/>')))).toContain('a chord note repeating a pitch of its chord was dropped');
    expect(warnings(wrap('<note><chord/><pitch><step>E</step><octave>4</octave></pitch><type>quarter</type></note>'))).toContain(
      'a chord note with no note to join was dropped',
    );
  });
  it('a clean file has none', () => expect(warnings(wrap(note()))).toEqual([]));
});

describe('every fixture exports to MusicXML and imports back', () => {
  it.each(Object.entries(FIXTURE_REGISTRY))('%s keeps its bar count, key and meter', (_name, build) => {
    const original = build();
    const { score } = musicXmlToScore(scoreToMusicXml(original), { id: 'rt' });
    expect(score.bars).toHaveLength(original.bars.length);
    expect(score.meta.key).toEqual(original.meta.key);
    expect(score.meta.time).toEqual(original.meta.time);
  });
});
