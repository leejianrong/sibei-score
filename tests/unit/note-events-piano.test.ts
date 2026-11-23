import { describe, expect, it } from 'vitest';
import { allStaves, mapNoteEventsToScore, parseNoteEvents, pitchToMidi, scoreMetrics } from '@sibei/model';
import type { Note, NoteEvents, Score } from '@sibei/model';
import { scoreToMusicXml } from '@sibei/codec';
import { renderScoreToSvg } from '@sibei/pdf';
import { JITTER_LEVELS, generatePianoScore, pianoScoreToNoteEvents, scorePianoImport } from '@sibei/synth';

/** Piano NoteEvents to a hand-split grand-staff draft (ADR-0040, SIB2-144). 120 bpm: 960 ticks a second. */

type Spec = [tick: number, ticks: number, midi: number, confidence?: number];

function piano(specs: Spec[], options: { downbeats?: boolean; bars?: number; warnings?: NoteEvents['warnings'] } = {}): NoteEvents {
  const bars = options.bars ?? 4;
  const marked = options.downbeats ?? true;
  return parseNoteEvents({
    schema_version: 1,
    source: { sha256: '0'.repeat(64), duration_s: bars * 2 + 1 },
    instrument: 'piano',
    producer: { model_id: 'test', model_version: '0', stage: 'transcribe' },
    beats: Array.from({ length: bars * 4 + 1 }, (_unused, i) => ({ t_s: i * 0.5, is_downbeat: marked ? i % 4 === 0 : null })),
    notes: specs.map(([tick, ticks, midi, confidence], i) => ({
      id: `n${i}`,
      onset_s: tick / 960,
      offset_s: (tick + ticks * 0.95) / 960,
      pitch: midi,
      confidence: confidence ?? 0.9,
    })),
    warnings: options.warnings ?? [],
  });
}

const map = (events: NoteEvents): Score => mapNoteEventsToScore(events, { id: 'import-1' }).score;

/** The struck notes of one staff in one bar, across its voices. */
function notesOf(score: Score, staff: 1 | 2, bar: number): Note[] {
  return allStaves(score)[staff - 1]!.bars[bar - 1]!.voices.flatMap((v) => v.items.filter((i): i is Note => i.kind === 'note'));
}
const midis = (notes: Note[]): number[] => notes.map((n) => pitchToMidi(n.pitch)).sort((a, b) => a - b);

describe('mapNoteEventsToScore for piano', () => {
  // Right hand: C5 E5 G5 C6 in quarters; left hand: C3 G3 in halves. Four bars of the same.
  const clear: Spec[] = [];
  for (let bar = 0; bar < 4; bar += 1) {
    [72, 76, 79, 84].forEach((m, i) => clear.push([bar * 1920 + i * 480, 480, m]));
    clear.push([bar * 1920, 960, 48], [bar * 1920 + 960, 960, 55]);
  }
  const draft = mapNoteEventsToScore(piano(clear), { id: 'import-1', title: 'Étude' });
  const { score } = draft;

  it('is one part named Piano (program 0) with a treble and a bass staff, laid out by width', () => {
    expect(score.parts).toHaveLength(1);
    expect(score.parts[0]!).toMatchObject({ name: 'Piano', instrument: 0 });
    expect(score.parts[0]!.staves.map((s) => s.clef)).toEqual(['treble', 'bass']);
    expect(score.meta.layout).toBe('score');
    expect(score.bars).toHaveLength(4);
  });

  it('puts the high line in the right hand and the low notes in the left on a clear case', () => {
    expect(midis(notesOf(score, 1, 1))).toEqual([72, 76, 79, 84]);
    expect(midis(notesOf(score, 2, 1))).toEqual([48, 55]);
    expect(midis(notesOf(score, 1, 4))).toEqual([72, 76, 79, 84]);
  });

  it('is metrically valid and engraves and exports as a grand staff', () => {
    expect(scoreMetrics(score).every((m) => m.valid)).toBe(true);
    expect(renderScoreToSvg(score)[0]!.svg).toContain('<svg');
    const xml = scoreToMusicXml(score);
    expect(xml).toContain('<staves>2</staves>');
    expect(xml).toContain('<sign>F</sign>');
  });

  it('says the hand split is a guess, in the diagnostics', () => {
    expect(draft.diagnostics.some((d) => d.startsWith('hand-split:'))).toBe(true);
    expect(draft.diagnostics.some((d) => d.includes('grand staff'))).toBe(true);
  });

  it('keeps a chord together in one hand where it fits', () => {
    const chord = map(piano([[0, 1920, 60], [0, 1920, 64], [0, 1920, 67]], { bars: 1 }));
    expect(midis(notesOf(chord, 1, 1))).toEqual([60, 64, 67]);
    expect(notesOf(chord, 2, 1)).toHaveLength(0);
    // The three notes are three voices of the staff, the top note in voice 1 (the model has no stacked chord).
    const voices = allStaves(chord)[0]!.bars[0]!.voices;
    expect(voices.map((v) => v.items.filter((i) => i.kind === 'note').length)).toEqual([1, 1, 1]);
    expect((voices[0]!.items[0] as Note).pitch).toMatchObject({ step: 'G', octave: 4 });
  });

  it('splits a chord too wide for one hand between the hands', () => {
    const wide = map(piano([[0, 1920, 36], [0, 1920, 43], [0, 1920, 52], [0, 1920, 67], [0, 1920, 72], [0, 1920, 76]], { bars: 1 }));
    expect(midis(notesOf(wide, 2, 1))).toEqual([36, 43, 52]);
    expect(midis(notesOf(wide, 1, 1))).toEqual([67, 72, 76]);
  });

  it('keeps a left-hand line that climbs through middle C in the left hand while the right hand plays above', () => {
    const specs: Spec[] = [];
    [55, 57, 59, 60, 62, 64, 65, 67].forEach((m, i) => specs.push([i * 240, 240, m], [i * 240, 240, m + 24]));
    const climbing = map(piano(specs, { bars: 1 }));
    expect(midis(notesOf(climbing, 2, 1))).toEqual([55, 57, 59, 60, 62, 64, 65, 67]);
    expect(midis(notesOf(climbing, 1, 1))).toEqual([79, 81, 83, 84, 86, 88, 89, 91]);
  });

  it('does not flip a lone note around the split from one note to the next', () => {
    // A right-hand melody wandering C4..E4 in the low treble keeps to one hand once it has started above.
    const specs: Spec[] = [];
    [72, 67, 64, 62, 60, 62, 64, 67].forEach((m, i) => specs.push([i * 240, 240, m]));
    const line = map(piano(specs, { bars: 1 }));
    expect(notesOf(line, 2, 1)).toHaveLength(0);
    expect(notesOf(line, 1, 1)).toHaveLength(8);
  });

  it('honours a different split point', () => {
    const low = mapNoteEventsToScore(piano([[0, 1920, 55]], { bars: 1 }), { id: 'x', splitPoint: 55 }).score;
    expect(notesOf(low, 1, 1)).toHaveLength(1);
    const high = mapNoteEventsToScore(piano([[0, 1920, 60]], { bars: 1 }), { id: 'x', splitPoint: 72 }).score;
    expect(notesOf(high, 2, 1)).toHaveLength(1);
  });

  it('separates two independent lines in one hand into voices 1 and 2', () => {
    // A melody of quarters over a held half note in the same hand: they overlap in time without sharing a duration.
    const two = map(piano([[0, 480, 76], [480, 480, 79], [960, 480, 77], [1440, 480, 74], [0, 960, 67], [960, 960, 65]], { bars: 1 }));
    const voices = allStaves(two)[0]!.bars[0]!.voices;
    expect(voices.map((v) => v.index)).toEqual([1, 2]);
    expect(midis(voices[0]!.items.filter((i): i is Note => i.kind === 'note'))).toEqual([74, 76, 77, 79]);
    expect(midis(voices[1]!.items.filter((i): i is Note => i.kind === 'note'))).toEqual([65, 67]);
    expect(scoreMetrics(two).every((m) => m.valid)).toBe(true);
    expect(notesOf(two, 2, 1)).toHaveLength(0);
  });

  it('ties a note across a bar line in its own voice', () => {
    const tied = map(piano([[0, 1440, 72], [1440, 960, 76], [2400, 1440, 72]], { bars: 2 }));
    const second = notesOf(tied, 1, 2);
    expect(second[0]!.tie).toBe('stop');
    expect(notesOf(tied, 1, 1).find((n) => pitchToMidi(n.pitch) === 76)!.tie).toBe('start');
    expect(scoreMetrics(tied).every((m) => m.valid)).toBe(true);
  });

  it('makes a pickup bar when notes precede the first downbeat', () => {
    // The beat grid's first downbeat is at 0.5 s: the note at 0 is a quarter pickup.
    const events = piano([[0, 480, 72], [480, 1920, 76]], { bars: 3 });
    const shifted = { ...events, beats: events.beats.map((b, i) => ({ ...b, t_s: i * 0.5, is_downbeat: i >= 1 && (i - 1) % 4 === 0 })) };
    const pickup = map(shifted);
    expect(pickup.bars[0]!.number).toBe(0);
    expect(notesOf(pickup, 1, 1)).toHaveLength(1);
  });

  it('flags bar 1 when the downbeats are null, and low-confidence notes', () => {
    const unmarked = mapNoteEventsToScore(piano([[0, 960, 72, 0.3], [960, 960, 48]], { downbeats: false, bars: 1 }), { id: 'x' });
    expect(unmarked.score.bars[0]!.review.flagged).toBe(true);
    expect(unmarked.diagnostics.some((d) => d.startsWith('no-downbeats'))).toBe(true);
    expect(notesOf(unmarked.score, 1, 1)[0]!.review.flagged).toBe(true);
    expect(notesOf(unmarked.score, 2, 1)[0]!.review.flagged).toBe(false);
  });

  it('is deterministic', () => {
    expect(map(piano(clear))).toEqual(map(piano(clear)));
  });

  it('maps a silent file to an empty two-staff draft with its warning kept', () => {
    const silent = mapNoteEventsToScore(piano([], { warnings: [{ code: 'silent_input', message: 'no notes found' }] }), { id: 'x' });
    expect(allStaves(silent.score)).toHaveLength(2);
    expect(silent.score.bars).toHaveLength(1);
    expect(silent.score.meta.layout).toBe('score');
    expect(notesOf(silent.score, 1, 1)).toHaveLength(0);
    expect(silent.diagnostics.some((d) => d.includes('silent_input'))).toBe(true);
    expect(silent.diagnostics.some((d) => d.startsWith('no-notes'))).toBe(true);
  });

  it('leaves the other instruments on their own mappers', () => {
    const voice = { ...piano([[0, 480, 72]], { bars: 1 }), instrument: 'voice' as const };
    expect(allStaves(mapNoteEventsToScore(voice, { id: 'x' }).score)).toHaveLength(1);
  });
});

describe('the piano eval corpus', () => {
  it('is reproducible and renders valid NoteEvents', () => {
    const a = generatePianoScore({ seed: 3 });
    expect(generatePianoScore({ seed: 3 })).toEqual(a);
    expect(generatePianoScore({ seed: 4 })).not.toEqual(a);
    for (const level of JITTER_LEVELS) {
      expect(() => parseNoteEvents(JSON.parse(JSON.stringify(pianoScoreToNoteEvents(a, { seed: 3, level }))))).not.toThrow();
    }
  });

  it('reads the notes and guesses the hands well on a clean rendering', () => {
    const scores = [0, 1, 2, 3, 4, 5].map((seed) => {
      const truth = generatePianoScore({ seed });
      return scorePianoImport(truth, pianoScoreToNoteEvents(truth, { seed, level: 'clean' }));
    });
    const mean = (pick: (m: (typeof scores)[number]) => number): number => scores.reduce((s, m) => s + pick(m), 0) / scores.length;
    expect(mean((m) => m.noteF1)).toBeGreaterThan(0.95);
    expect(mean((m) => m.handAccuracy)).toBeGreaterThan(0.93);
  });
});
