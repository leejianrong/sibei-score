import { describe, expect, it } from 'vitest';
import { keyFromFifths, musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { aabaChart, nastyChart } from '@sibei/fixtures';
import {
  dur,
  keyFifths,
  makeBar,
  makeChord,
  makeNote,
  makeScore,
  makeSection,
} from '@sibei/model';
import type { KeySignature, Score } from '@sibei/model';

/**
 * The MusicXML round-trip (V8b, ADR-0004, and the V5 test plan's promise carried out).
 *
 * ADR-0004 is explicit that the codec is lossy in both directions and that this must be documented
 * rather than pretended away. So the suite is two halves: **what the format can express round-trips
 * exactly** (a musical signature of the two richest fixtures survives export → import), and **every
 * lossy case is named** — a test per field MusicXML has no home for, asserting it is dropped or
 * normalised, so a loss is a decision on record rather than a surprise later.
 */

/**
 * Everything MusicXML can carry for a single-voice lead sheet, extracted for comparison. Onsets and
 * durations, ties and tuplets, chord text and beat, barlines, endings, rehearsal letters, key and
 * meter — but *not* the app-owned ids, the accidental display mode, the spelling pins, or the
 * confidence/review flags, which are the lossy half asserted separately below.
 */
function signature(score: Score): unknown {
  return {
    title: score.meta.title,
    composer: score.meta.composer,
    key: score.meta.key,
    time: score.meta.time,
    sections: [...score.sections]
      .sort((a, b) => a.startBar - b.startBar)
      .map((s) => ({ startBar: s.startBar, letter: s.letter })),
    bars: score.bars.map((bar) => ({
      number: bar.number,
      startBarline: bar.startBarline,
      endBarline: bar.endBarline,
      ending: bar.ending,
      items: bar.items.map((item) =>
        item.kind === 'note'
          ? { kind: 'note', onset: item.onset, duration: item.duration, pitch: item.pitch, tie: item.tie }
          : { kind: 'rest', onset: item.onset, duration: item.duration },
      ),
      // A tuplet by its ratio and the onsets of its members, which is identity-free.
      tuplets: bar.tuplets.map((tuplet) => ({
        actual: tuplet.actual,
        normal: tuplet.normal,
        members: tuplet.memberIds
          .map((id) => bar.items.find((i) => i.id === id)?.onset)
          .filter((onset) => onset !== undefined),
      })),
      chords: [...bar.chords].sort((a, b) => a.onset - b.onset).map((c) => ({ onset: c.onset, text: c.text })),
    })),
  };
}

function roundTrip(score: Score): { score: Score; warnings: string[] } {
  return musicXmlToScore(scoreToMusicXml(score), { id: score.id });
}

describe('the round-trip preserves everything MusicXML can express', () => {
  it('holds for the nasty chart: ties across barlines, triplets, a pickup, double bars, dense chords', () => {
    const original = nastyChart();
    const { score, warnings } = roundTrip(original);
    expect(warnings).toEqual([]);
    expect(signature(score)).toEqual(signature(original));
  });

  it('holds for the AABA chart: rehearsal letters, a repeat, and 1st/2nd endings', () => {
    const original = aabaChart();
    const { score, warnings } = roundTrip(original);
    expect(warnings).toEqual([]);
    expect(signature(score)).toEqual(signature(original));
  });

  it('carries every chord spelling from the V5 grammar list through with its structure intact', () => {
    const spellings = ['C', 'Cmaj7', 'Cm7', 'F#m7b5', 'C7alt', 'Bb13#11', 'Ab/Eb', 'N.C.'];
    const score = makeScore({
      id: 's',
      bars: [
        makeBar({
          id: 'bar-1',
          number: 1,
          items: [makeNote({ id: 'note-1', onset: 0, duration: dur(1), pitch: 'C5' })],
          chords: spellings.map((text, i) => makeChord({ id: `chord-${i}`, onset: i * 10, text })),
        }),
      ],
    });
    const { score: back } = roundTrip(score);
    expect(back.bars[0]!.chords.map((c) => c.text)).toEqual(spellings);
  });

  it('is stable a second time: importing the re-export reproduces the first import exactly', () => {
    const once = roundTrip(nastyChart()).score;
    const twice = musicXmlToScore(scoreToMusicXml(once), { id: once.id }).score;
    expect(signature(twice)).toEqual(signature(once));
  });
});

describe('keyFromFifths is the exact inverse of keyFifths', () => {
  it('recovers the conventional key for every position on the circle, major and minor', () => {
    for (let fifths = -7; fifths <= 7; fifths += 1) {
      for (const mode of ['major', 'minor'] as const) {
        const key = keyFromFifths(fifths, mode);
        expect(keyFifths(key)).toBe(fifths);
        expect(key.mode).toBe(mode);
      }
    }
  });

  it('round-trips a chart in a flat minor key', () => {
    const key: KeySignature = { tonic: 'B', alter: -1, mode: 'minor' };
    const score = makeScore({ id: 's', key, bars: [makeBar({ id: 'bar-1', number: 1 })] });
    expect(roundTrip(score).score.meta.key).toEqual(key);
  });
});

/**
 * The lossy half, named case by case (ADR-0004). Each builds a score that sets exactly one thing
 * MusicXML has no home for and asserts the round-trip drops or normalises it.
 */
describe('the documented lossy cases', () => {
  const withOneNote = (over: Parameters<typeof makeNote>[0], extra: Partial<Parameters<typeof makeBar>[0]> = {}): Score =>
    makeScore({
      id: 's',
      bars: [makeBar({ id: 'bar-1', number: 1, items: [makeNote(over)], ...extra })],
    });

  it('mints fresh ids: app-owned ids do not survive (ADR-0004, ADR-0007)', () => {
    const score = withOneNote({ id: 'note-original', onset: 0, duration: dur(1), pitch: 'C5' });
    const back = roundTrip(score).score;
    // The note is still there, at the same place — but under a new id.
    expect(back.bars[0]!.items[0]!.id).not.toBe('note-original');
    expect(back.bars[0]!.items[0]!.onset).toBe(0);
  });

  it("normalises a note's accidental display mode: 'show'/'hide' become 'auto'", () => {
    const shown = withOneNote({ id: 'note-1', onset: 0, duration: dur(1), pitch: 'F#5', accidental: 'show' });
    const note = roundTrip(shown).score.bars[0]!.items[0]!;
    expect(note.kind).toBe('note');
    if (note.kind === 'note') expect(note.accidental).toBe('auto');
  });

  it('drops spellingPinned on notes and chords', () => {
    const score = makeScore({
      id: 's',
      bars: [
        makeBar({
          id: 'bar-1',
          number: 1,
          items: [makeNote({ id: 'note-1', onset: 0, duration: dur(1), pitch: 'C5', spellingPinned: true })],
          chords: [makeChord({ id: 'chord-1', onset: 0, text: 'C7', spellingPinned: true })],
        }),
      ],
    });
    const back = roundTrip(score).score;
    const note = back.bars[0]!.items[0]!;
    expect(note.kind === 'note' && note.spellingPinned).toBe(false);
    expect(back.bars[0]!.chords[0]!.spellingPinned).toBe(false);
  });

  it('drops confidence and review flags: recognition metadata has no MusicXML home', () => {
    const score = withOneNote({
      id: 'note-1',
      onset: 0,
      duration: dur(1),
      pitch: 'C5',
      confidence: 0.4,
      review: { flagged: true, reasons: ['low-confidence'] },
    });
    const note = roundTrip(score).score.bars[0]!.items[0]!;
    expect(note.confidence).toBeNull();
    expect(note.review).toEqual({ flagged: false, reasons: [] });
  });

  it('drops the style line', () => {
    const score = makeScore({ id: 's', style: 'Medium swing', bars: [makeBar({ id: 'bar-1', number: 1 })] });
    expect(roundTrip(score).score.meta.style).toBeNull();
  });

  it("drops a section's free-text name but keeps its rehearsal letter", () => {
    const score = makeScore({
      id: 's',
      bars: [makeBar({ id: 'bar-1', number: 1 }), makeBar({ id: 'bar-2', number: 2 })],
      sections: [makeSection({ id: 'sec-1', startBar: 1, letter: 'A', name: 'Head' })],
    });
    const back = roundTrip(score).score;
    expect(back.sections).toHaveLength(1);
    expect(back.sections[0]).toMatchObject({ startBar: 1, letter: 'A', name: null });
  });

  it('loses a section that has a name but no letter: nothing anchors a rehearsal mark', () => {
    const score = makeScore({
      id: 's',
      bars: [makeBar({ id: 'bar-1', number: 1 }), makeBar({ id: 'bar-2', number: 2 })],
      sections: [makeSection({ id: 'sec-1', startBar: 2, letter: null, name: 'Bridge' })],
    });
    expect(roundTrip(score).score.sections).toEqual([]);
  });

  it('loses chord text the grammar cannot parse, which MusicXML cannot express as a harmony', () => {
    const score = makeScore({
      id: 's',
      bars: [
        makeBar({
          id: 'bar-1',
          number: 1,
          items: [makeNote({ id: 'note-1', onset: 0, duration: dur(1), pitch: 'C5' })],
          chords: [makeChord({ id: 'chord-1', onset: 0, text: 'solo break' })],
        }),
      ],
    });
    // Recovered verbatim by *this* codec via the kind text, but named as the lossy case it is for a
    // third party: MusicXML has no faithful harmony for unparseable text.
    const back = roundTrip(score).score;
    expect(back.bars[0]!.chords.map((c) => c.text)).toEqual(['solo break']);
  });
});

describe('the importer reads leniently (ADR-0012 the codec half)', () => {
  it('rejects a non-partwise document loudly rather than guessing', () => {
    expect(() => musicXmlToScore('<other/>')).toThrow(/score-partwise/);
    expect(() => musicXmlToScore('<score-timewise/>')).toThrow(/timewise/);
  });

  it('drops a second voice with a warning rather than refusing the import', () => {
    const twoVoices = [
      '<score-partwise><part-list><score-part id="P1"/></part-list><part id="P1"><measure number="1">',
      '<attributes><divisions>480</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>',
      '<note><pitch><step>C</step><octave>5</octave></pitch><duration>1920</duration><type>whole</type></note>',
      '<backup><duration>1920</duration></backup>',
      '<note><pitch><step>E</step><octave>4</octave></pitch><duration>1920</duration><type>whole</type></note>',
      '</measure></part></score-partwise>',
    ].join('');
    const { score, warnings } = musicXmlToScore(twoVoices);
    expect(score.bars[0]!.items).toHaveLength(1);
    expect(warnings.some((w) => /single-voice/.test(w))).toBe(true);
  });
});
