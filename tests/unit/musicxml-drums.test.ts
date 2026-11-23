import { describe, expect, it } from 'vitest';
import { allStaves, drumById, isDrumKitStaff, scoreMetrics } from '@sibei/model';
import type { Note, Score } from '@sibei/model';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { drumChart } from '@sibei/fixtures';

/**
 * ADR-0041 slice 6 (SIB2-237): a drum kit is `<unpitched>` notes with an `<instrument>` each, the part's
 * `<score-instrument>`/`<midi-instrument>` map (`<midi-unpitched>`, 1-based) and a `<notehead>`, and reads back to the
 * same drums, heads and voices.
 */

const compact = (xml: string): string => xml.replace(/>\s+</g, '><');

/** Every drum note of the first staff by voice and bar (voices with no hit left out): drum, head override, onset, duration. */
function drumsOf(score: Score): unknown {
  const staff = allStaves(score)[0]!;
  return staff.bars.map((bar) =>
    bar.voices
      .map((voice) => ({
        voice: voice.index,
        notes: voice.items
          .filter((item): item is Note => item.kind === 'note')
          .map((n) => [n.drum, n.head, n.onset, n.duration.value]),
      }))
      .filter((voice) => voice.notes.length > 0),
  );
}

describe('MusicXML export of a drum kit', () => {
  const xml = compact(scoreToMusicXml(drumChart()));

  it('names each drum used as an instrument with its General MIDI key (1-based) on channel 10', () => {
    expect(xml).toContain('<score-instrument id="P1-I36"><instrument-name>Kick</instrument-name></score-instrument>');
    expect(xml).toContain('<midi-instrument id="P1-I36"><midi-channel>10</midi-channel><midi-unpitched>37</midi-unpitched></midi-instrument>');
    expect(xml).toContain('<midi-unpitched>39</midi-unpitched>'); // snare, GM 38
    expect(xml).toContain('<midi-unpitched>47</midi-unpitched>'); // open hi-hat, GM 46
    // Only drums the chart uses: no splash.
    expect(xml).not.toContain('Splash');
  });

  it('writes a drum as an unpitched note at its display pitch with its instrument and notehead', () => {
    expect(xml).toContain(
      '<note><unpitched><display-step>G</display-step><display-octave>5</display-octave></unpitched><duration>240</duration><instrument id="P1-I42"/>',
    );
    expect(xml).toContain('<notehead>x</notehead>');
    expect(xml).toContain('<notehead>circle-x</notehead>');
    expect(xml).toContain('<notehead>diamond</notehead>');
    // A snare is an ordinary oval: no notehead element needed.
    expect(xml).toMatch(/<instrument id="P1-I38"\/><voice>3<\/voice><type>quarter<\/type><\/note>/);
  });

  it('is deterministic', () => {
    expect(scoreToMusicXml(drumChart())).toBe(scoreToMusicXml(drumChart()));
  });
});

describe('MusicXML round trip of a drum kit', () => {
  const original = drumChart();
  const back = musicXmlToScore(scoreToMusicXml(original));

  it('reads back the same drums, heads, onsets and values in the same voices', () => {
    expect(back.warnings).toEqual([]);
    expect(drumsOf(back.score)).toEqual(drumsOf(original));
  });

  it('is still a drum kit on a percussion staff, and every bar still fills its meter', () => {
    expect(allStaves(back.score)[0]!.type).toBe('percussion');
    expect(isDrumKitStaff(allStaves(back.score)[0]!)).toBe(true);
    expect(scoreMetrics(back.score).every((m) => m.valid)).toBe(true);
  });

  it('keeps a head the note overrides, and drops one that is only its drum\'s own', () => {
    const notes = allStaves(back.score)[0]!.bars.flatMap((bar) => bar.voices.flatMap((v) => v.items)).filter((i): i is Note => i.kind === 'note');
    expect(notes.find((n) => n.drum === 'ride-bell')!.head).toBeUndefined();
    expect(notes.find((n) => n.drum === 'hihat')!.head).toBeUndefined();
    expect(drumById('ride-bell').head).toBe('diamond');
  });
});

describe('MusicXML import of a drum file as other programs write it', () => {
  const part = (body: string): string =>
    `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Drumset</part-name>` +
    `<score-instrument id="P1-I36"><instrument-name>Bass Drum</instrument-name></score-instrument>` +
    `<score-instrument id="P1-I43"><instrument-name>Closed Hi-Hat</instrument-name></score-instrument>` +
    `<midi-instrument id="P1-I36"><midi-channel>10</midi-channel><midi-unpitched>36</midi-unpitched></midi-instrument>` +
    `</score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>percussion</sign></clef></attributes>${body}</measure></part></score-partwise>`;

  const hit = (instrument: string, step: string, octave: number, voice: number, extra = '', chord = false): string =>
    `<note>${chord ? '<chord/>' : ''}<unpitched><display-step>${step}</display-step><display-octave>${octave}</display-octave></unpitched>` +
    `<duration>2</duration><instrument id="${instrument}"/><voice>${voice}</voice><type>quarter</type>${extra}</note>`;

  it('maps an instrument by its midi-unpitched (kick 36 is GM 35) and by its name (a hi-hat without a key)', () => {
    const { score } = musicXmlToScore(part(hit('P1-I36', 'F', 4, 1) + hit('P1-I43', 'G', 5, 1, '<notehead>x</notehead>')));
    const notes = allStaves(score)[0]!.bars[0]!.voices[0]!.items.filter((i): i is Note => i.kind === 'note');
    expect(notes.map((n) => n.drum)).toEqual(['kick', 'hihat']);
    // The hi-hat's x is its drum's own, so no override is kept.
    expect(notes[1]!.head).toBeUndefined();
  });

  it('reads drums struck together (a chord) as separate voices, with each bar still filled', () => {
    const body =
      hit('P1-I43', 'G', 5, 1) + hit('P1-I36', 'F', 4, 1, '', true) + hit('P1-I43', 'G', 5, 1) + hit('P1-I43', 'G', 5, 1) + hit('P1-I43', 'G', 5, 1);
    const { score, warnings } = musicXmlToScore(part(body));
    expect(warnings.join(' ')).toContain('separate voices');
    const voices = allStaves(score)[0]!.bars[0]!.voices;
    expect(voices.map((v) => v.index)).toEqual([1, 2]);
    expect(voices[1]!.items.filter((i) => i.kind === 'note')).toHaveLength(1);
    expect(scoreMetrics(score).every((m) => m.valid)).toBe(true);
  });

  it('reads an unknown notehead as an x, with a note', () => {
    const { score, warnings } = musicXmlToScore(part(hit('P1-I36', 'F', 4, 1, '<notehead>triangle</notehead>')));
    expect(warnings.join(' ')).toContain('"triangle" was read as an x');
    expect((allStaves(score)[0]!.bars[0]!.voices[0]!.items[0] as Note).head).toBe('x');
  });
});
