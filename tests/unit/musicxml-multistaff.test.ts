import { allStaves, barViews, makeStaffedScore, voiceSelects } from '@sibei/model';
import type { Score } from '@sibei/model';
import { describe, expect, it } from 'vitest';
import { musicXmlToScore, parseXml, scoreToMusicXml } from '@sibei/codec';
import { FIXTURE_REGISTRY } from '@sibei/fixtures';

/**
 * ADR-0041 slice 5a (SIB2-229): MusicXML carries parts, staves and voices both ways. The round trip keeps every
 * staff and voice's notes (ids aside, which MusicXML never carries); what it loses is named below.
 */

/** The serializer indents; a test reads the tags. */
const compact = (xml: string): string => xml.replace(/>\s+</g, '><');

const MULTI = ['grand-staff', 'two-voice', 'lead-bass', 'full-band'] as const;

/** A score reduced to what MusicXML keeps: the music of every staff and voice, with ids and review flags dropped. */
function essence(score: Score): unknown {
  return {
    parts: score.parts.map((part) => ({
      name: part.name,
      instrument: part.instrument,
      transposition: part.transposition,
      staves: part.staves.map((staff) => ({
        type: staff.type,
        clef: staff.clef,
        voices: voiceSelects({ ...score, parts: [{ ...part, staves: [staff] }] }).map(({ voice }) => ({
          voice,
          bars: barViews({ ...score, parts: [{ ...part, staves: [staff] }] }, { staff: staff.id, voice }).map((bar) =>
            bar.items.map((item) =>
              item.kind === 'note'
                ? [item.onset, item.duration, item.pitch, item.tie]
                : ['rest', item.onset, item.duration],
            ),
          ),
        })),
      })),
    })),
  };
}

describe('every multi-staff fixture exports to MusicXML and imports back', () => {
  it.each(MULTI)('%s keeps its parts, staves, voices and notes', (name) => {
    const original = (FIXTURE_REGISTRY[name] as () => Score)();
    const { score, warnings } = musicXmlToScore(scoreToMusicXml(original), { id: 'rt' });
    // A part with no name comes back with none; the rest of the structure is exactly as it was.
    expect(essence(score)).toEqual(essence(original));
    expect(warnings).toEqual([]);
    expect(score.bars).toHaveLength(original.bars.length);
    expect(score.harmony.map((entry) => entry.chords.map((c) => [c.onset, c.text]))).toEqual(
      original.harmony.map((entry) => entry.chords.map((c) => [c.onset, c.text])),
    );
    expect(allStaves(score).map((s) => s.id)).toEqual(allStaves(original).map((s) => s.id));
  });

  it('writes the structure MusicXML needs', () => {
    const xml = compact(scoreToMusicXml((FIXTURE_REGISTRY['full-band'] as () => Score)()));
    const root = parseXml(xml);
    const parts = root.children.filter((c): c is typeof root => 'name' in c && c.name === 'part');
    expect(parts).toHaveLength(4);
    expect(xml).toContain('<part-group type="start" number="1">');
    expect(xml).toContain('<staves>2</staves>');
    expect(xml).toContain('<clef number="2"><sign>F</sign><line>4</line></clef>');
    expect(xml).toContain('<sign>percussion</sign>');
    expect(xml).toContain('<unpitched><display-step>F</display-step><display-octave>5</display-octave></unpitched>');
    expect(xml).toContain('<midi-program>66</midi-program>'); // GM program 65, 1-based in MusicXML
    expect(xml).toContain('<midi-channel>10</midi-channel>');
  });

  it('numbers voices per part and rewinds with a backup', () => {
    const xml = compact(scoreToMusicXml((FIXTURE_REGISTRY['two-voice'] as () => Score)()));
    expect(xml).toContain('<voice>1</voice>');
    expect(xml).toContain('<voice>2</voice>');
    // Every second voice starts with a backup of exactly the first voice's length.
    const firstMeasure = xml.slice(xml.indexOf('<measure'), xml.indexOf('</measure>'));
    expect(firstMeasure).toMatch(/<backup><duration>\d+<\/duration><\/backup>/);
    const sums = (text: string): number =>
      [...text.matchAll(/<duration>(\d+)<\/duration>/g)].reduce((n, m) => n + Number(m[1]), 0);
    const [voice1, rest] = firstMeasure.split('<backup>');
    const [backup, voice2] = (rest as string).split('</backup>');
    expect(sums(backup as string)).toBe(sums(voice1 as string));
    expect(sums(voice2 as string)).toBeLessThanOrEqual(sums(voice1 as string));
  });

  it('writes the first staff of a grand staff before the second, and chords once', () => {
    const xml = compact(scoreToMusicXml((FIXTURE_REGISTRY['grand-staff'] as () => Score)()));
    const first = xml.slice(xml.indexOf('<measure'), xml.indexOf('</measure>'));
    expect(first.indexOf('<staff>1</staff>')).toBeLessThan(first.indexOf('<staff>2</staff>'));
    expect(first).toContain('<backup>');
    expect((xml.match(/<harmony>/g) ?? []).length).toBe(
      (FIXTURE_REGISTRY['grand-staff'] as () => Score)().harmony.reduce((n, h) => n + h.chords.length, 0),
    );
  });
});

describe('a transposing part', () => {
  const build = (): Score =>
    makeStaffedScore({
      id: 'trumpet',
      title: 'T',
      key: { tonic: 'B', alter: -1, mode: 'major' },
      bars: [
        {
          id: 'bar-1',
          number: 1,
          items: [],
          tuplets: [],
          chords: [],
          annotations: [],
          startBarline: 'none',
          endBarline: 'single',
          ending: null,
          review: { flagged: false, reasons: [] },
        },
      ],
      parts: [
        {
          name: 'Trumpet',
          instrument: 56,
          transposition: 2,
          staves: [
            {
              bars: [
                {
                  items: [
                    {
                      kind: 'note',
                      id: 'n1',
                      onset: 0,
                      duration: { value: 1, dots: 0 },
                      pitch: { step: 'B', alter: -1, octave: 4 },
                      accidental: 'auto',
                      tie: 'none',
                      spellingPinned: false,
                      confidence: null,
                      review: { flagged: false, reasons: [] },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

  it('is written a tone above concert with a <transpose>, and read back to concert', () => {
    const xml = compact(scoreToMusicXml(build()));
    expect(xml).toContain('<transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose>');
    // Concert Bb4 is written C5 in a part whose key signature is C major (no fifths).
    expect(xml).toContain('<pitch><step>C</step><octave>5</octave></pitch>');
    expect(xml).toContain('<fifths>0</fifths>');
    const { score } = musicXmlToScore(xml);
    expect(score.meta.key).toEqual({ tonic: 'B', alter: -1, mode: 'major' });
    expect(score.parts[0]?.transposition).toBe(2);
    expect(score.parts[0]?.instrument).toBe(56);
    expect(score.parts[0]?.name).toBe('Trumpet');
    expect(barViews(score)[0]?.items[0]).toMatchObject({ pitch: { step: 'B', alter: -1, octave: 4 } });
  });

  it('keeps the octave of a tenor saxophone (a major ninth)', () => {
    const score = build();
    (score.parts[0] as { transposition: number }).transposition = 14;
    const xml = compact(scoreToMusicXml(score));
    expect(xml).toContain('<chromatic>-2</chromatic><octave-change>-1</octave-change>');
    const back = musicXmlToScore(xml).score;
    expect(back.parts[0]?.transposition).toBe(14);
    expect(barViews(back)[0]?.items[0]).toMatchObject({ pitch: { step: 'B', alter: -1, octave: 4 } });
  });
});
