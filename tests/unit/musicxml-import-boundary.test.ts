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

  it('extra parts', () => expect(warnings(wrap(note(), '', 3))).toContain('2 further parts dropped: only the first part is read'));
  it('extra staves', () => {
    expect(warnings(wrap(note(), '<staves>2</staves>')).join('|')).toContain('2-staff part was read as its first staff only');
    expect(warnings(wrap(note('<staff>2</staff>'))).join('|')).toContain('second staff');
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
    expect(result.score.bars[0]!.items).toHaveLength(1);
    const first = result.score.bars[0]!.items[0];
    expect(first?.kind === 'note' ? first.graces?.length : 0).toBe(1);
  });
  it('a grace note with no note after it is dropped with a warning', () => {
    const grace = '<note><grace/><pitch><step>D</step><octave>4</octave></pitch><type>eighth</type></note>';
    const result = musicXmlToScore(wrap(note() + grace));
    expect(result.warnings).toContain('grace notes with no note after them were dropped');
  });
  it('a second voice and a chord tone', () => {
    expect(warnings(wrap(note() + '<backup><duration>4</duration></backup>' + note()))).toContain(
      'a second voice was dropped: single-voice only',
    );
    expect(warnings(wrap(note() + note('<chord/>')))).toContain(
      'a chord note (a second simultaneous pitch) was dropped: single-voice only',
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
