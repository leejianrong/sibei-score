import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_STEMS, NoteEventsError, parseNoteEvents, allStaves, barViews, invalidBars, mapNoteEventsToScore, mapStemsToScore, pickGridStem, scoreMetrics } from '@sibei/model';
import type { Note, NoteEvents, Score } from '@sibei/model';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { fullBandChart } from '@sibei/fixtures';
import { renderScoreToSvg } from '@sibei/pdf';
import { JITTER_LEVELS, scoreStemsImport, scoreToStems } from '@sibei/synth';

/** Several NoteEvents (one per stem) onto one multi-part score on one shared bar grid (SIB2-147). */

const truth = fullBandChart();
const stems = (level: Parameters<typeof scoreToStems>[1]['level'] = 'light', seed = 3): NoteEvents[] => scoreToStems(truth, { seed, level });
const byInstrument = (all: NoteEvents[], instrument: string): NoteEvents => all.find((s) => s.instrument === instrument)!;
const notesOf = (score: Score, part: number, bar: number): Note[] =>
  score.parts[part]!.staves[0]!.bars[bar - 1]!.voices.flatMap((v) => v.items.filter((i): i is Note => i.kind === 'note'));

describe('mapStemsToScore: the shared grid and the parts', () => {
  const all = stems();
  const { score, diagnostics } = mapStemsToScore(all, { id: 'audio-1', title: 'Band' });

  it('makes one part per stem in conventional order, named, with GM programs', () => {
    expect(score.parts.map((p) => p.name)).toEqual(['Voice', 'Piano', 'Bass', 'Drums']);
    expect(score.parts.map((p) => p.instrument)).toEqual([54, 0, 33, null]);
    expect(score.parts.map((p) => p.staves.length)).toEqual([1, 2, 1, 1]);
    expect(score.parts[3]!.staves[0]!.type).toBe('percussion');
    expect(score.parts[2]!.staves[0]!.clef).toBe('bass');
    expect(score.meta.layout).toBe('score');
    expect(score.meta.title).toBe('Band');
  });

  it('keeps the input order irrelevant: drums first still ends up last', () => {
    const shuffled = [...all].reverse();
    expect(mapStemsToScore(shuffled, { id: 'x' }).score.parts.map((p) => p.name)).toEqual(['Voice', 'Piano', 'Bass', 'Drums']);
  });

  it('puts every staff on the same bars: one grid, one meter', () => {
    expect(score.meta.time).toEqual({ beats: 4, beatValue: 4 });
    for (const staff of allStaves(score)) {
      expect(staff.bars.map((b) => b.barId)).toEqual(score.bars.map((b) => b.id));
    }
    expect(score.bars).toHaveLength(16);
    expect(invalidBars(score)).toEqual([]);
  });

  it('keeps the parts aligned: the bass root lands on the bar line in every bar', () => {
    for (let bar = 1; bar <= 16; bar += 1) {
      const first = notesOf(score, 2, bar)[0]!;
      expect(first.onset).toBe(0);
    }
    // The lead sings E5 on beat one, the left hand plays the root.
    expect(notesOf(score, 0, 1)[0]!.pitch).toMatchObject({ step: 'E', octave: 5 });
  });

  it('infers one key over the pitched stems and spells every part in it', () => {
    expect(score.meta.key).toEqual({ tonic: 'C', alter: 0, mode: 'major' });
  });

  it('has globally unique item ids', () => {
    const ids = allStaves(score).flatMap((s) => s.bars.flatMap((b) => b.voices.flatMap((v) => v.items.map((i) => i.id))));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(allStaves(score).map((s) => s.id)).size).toBe(allStaves(score).length);
  });

  it('reports one inference line and no per-stem grid noise', () => {
    expect(diagnostics.filter((d) => d.startsWith('inferred:'))).toEqual(['inferred: C major, 4/4, about ' + diagnostics.find((d) => d.startsWith('inferred:'))!.split('about ')[1]]);
    expect(diagnostics.some((d) => d.includes('4 stems'))).toBe(true);
  });

  it('is deterministic', () => {
    expect(mapStemsToScore(all, { id: 'audio-1', title: 'Band' })).toEqual({ score, diagnostics });
  });
});

describe('a one-stem set is the single-stem import', () => {
  it('maps a lone voice stem to the same notes as the plain mapper', () => {
    const voice = byInstrument(stems(), 'voice');
    const one = mapStemsToScore([voice], { id: 'a' }).score;
    const plain = mapNoteEventsToScore(voice, { id: 'a' }).score;
    expect(barViews(one).map((b) => b.items.map((i) => [i.kind, i.onset]))).toEqual(barViews(plain).map((b) => b.items.map((i) => [i.kind, i.onset])));
  });
});

describe('the grid stem', () => {
  it('prefers marked downbeats, then more beats, then drums, bass, piano, voice', () => {
    const all = stems();
    // Every stem has the same grid shape: the tie goes to drums.
    expect(all[pickGridStem(all)]!.instrument).toBe('drums');
    const withoutDrums = all.filter((s) => s.instrument !== 'drums');
    expect(withoutDrums[pickGridStem(withoutDrums)]!.instrument).toBe('bass');
    const unmarked = all.map((s) => (s.instrument === 'drums' ? { ...s, beats: s.beats.map((b) => ({ t_s: b.t_s, is_downbeat: null })) } : s));
    expect(unmarked[pickGridStem(unmarked)]!.instrument).toBe('bass');
    const longer = all.map((s) => (s.instrument === 'voice' ? { ...s, beats: [...s.beats, { t_s: 999, is_downbeat: false }] } : s));
    expect(longer[pickGridStem(longer)]!.instrument).toBe('voice');
  });

  it('survives the best grid being the one the others lack', () => {
    const all = stems().map((s) => (s.instrument === 'drums' ? s : { ...s, beats: [] }));
    const { score } = mapStemsToScore(all, { id: 'g' });
    expect(score.bars).toHaveLength(16);
    expect(notesOf(score, 2, 1)[0]!.onset).toBe(0);
  });
});

describe('with no downbeats marked the barring is a guess', () => {
  const { score, diagnostics } = mapStemsToScore(stems('unmarked'), { id: 'u' });
  it('flags bar 1 once and says so once', () => {
    expect(score.bars[0]!.review?.flagged).toBe(true);
    expect(diagnostics.filter((d) => d.startsWith('no-downbeats:'))).toHaveLength(1);
  });
});

describe('a stem with no notes', () => {
  const all = stems().map((s) => (s.instrument === 'bass' ? { ...s, notes: [] } : s));
  const { score, diagnostics } = mapStemsToScore(all, { id: 'e' });
  it('is an empty part with a warning, not an error', () => {
    expect(score.parts.map((p) => p.name)).toEqual(['Voice', 'Piano', 'Bass', 'Drums']);
    expect(score.parts[2]!.staves[0]!.bars).toHaveLength(score.bars.length);
    expect(notesOf(score, 2, 1)).toEqual([]);
    expect(diagnostics).toContain('bass: no-notes: the stem has no notes; kept as an empty part');
    expect(invalidBars(score)).toEqual([]);
  });
  it('still maps when every stem is empty', () => {
    const none = mapStemsToScore(all.map((s) => ({ ...s, notes: [] })), { id: 'n' });
    expect(none.score.bars).toHaveLength(1);
    expect(none.score.parts).toHaveLength(4);
  });
});

describe('a stem that starts late opens with rests, on the shared bars', () => {
  it('lines the late stem up with the others', () => {
    const all = stems('clean');
    const late = all.map((s) => (s.instrument === 'voice' ? { ...s, notes: s.notes.filter((n) => n.onset_s > 8) } : s));
    const { score } = mapStemsToScore(late, { id: 'l' });
    expect(score.bars).toHaveLength(16);
    expect(notesOf(score, 0, 1)).toEqual([]);
    expect(scoreMetrics(score).every((m) => m.valid)).toBe(true);
  });
});

describe('a set that is not one recording is refused whole', () => {
  const all = stems();
  it('on a different source hash, naming the stem', () => {
    const bad = all.map((s, i) => (i === 2 ? { ...s, source: { ...s.source, sha256: 'f'.repeat(64) } } : s));
    expect(() => mapStemsToScore(bad, { id: 'x' })).toThrow(NoteEventsError);
    expect(() => mapStemsToScore(bad, { id: 'x' })).toThrow(/stems\[2\]\.source\.sha256/);
  });
  it('on a different duration', () => {
    const bad = all.map((s, i) => (i === 1 ? { ...s, source: { ...s.source, duration_s: s.source.duration_s + 5 } } : s));
    expect(() => mapStemsToScore(bad, { id: 'x' })).toThrow(/stems\[1\]\.source\.duration_s/);
  });
  it('on too many stems or none', () => {
    expect(() => mapStemsToScore([], { id: 'x' })).toThrow(/stems is empty/);
    expect(() => mapStemsToScore(Array.from({ length: MAX_STEMS + 1 }, () => all[0]!), { id: 'x' })).toThrow(/at most 12/);
  });
});

describe('an instrument this build cannot notate', () => {
  const all = stems();
  const withGuitar = [...all, { ...byInstrument(all, 'voice'), instrument: 'guitar' as const }];
  const { score, diagnostics } = mapStemsToScore(withGuitar, { id: 'g' });
  it('becomes a two-staff polyphonic part with a warning, after the voice', () => {
    expect(score.parts.map((p) => p.name)).toEqual(['Voice', 'Guitar', 'Piano', 'Bass', 'Drums']);
    expect(diagnostics.some((d) => d.startsWith('guitar: unsupported-instrument:'))).toBe(true);
    expect(score.parts[1]!.staves).toHaveLength(2);
    expect(score.parts[1]!.instrument).toBe(24);
  });
  it('names a second stem of one instrument with its number', () => {
    const two = mapStemsToScore([...all, { ...byInstrument(all, 'voice') }], { id: 'v' }).score;
    expect(two.parts.map((p) => p.name)).toEqual(['Voice', 'Voice 2', 'Piano', 'Bass', 'Drums']);
  });
});

describe('every stem keeps its own warnings and doubts', () => {
  it('prefixes stem warnings by instrument and keeps low-confidence flags', () => {
    const all = stems().map((s) =>
      s.instrument === 'bass'
        ? { ...s, notes: s.notes.map((n, i) => (i === 0 ? { ...n, confidence: 0.3 } : n)), warnings: [{ code: 'low_confidence', message: 'muddy low end', t_s: 0.01 }] }
        : s,
    );
    const { score, diagnostics } = mapStemsToScore(all, { id: 'w' });
    expect(diagnostics).toContain('bass: low_confidence: muddy low end (at 0.01s)');
    expect(notesOf(score, 2, 1)[0]!.review.flagged).toBe(true);
  });
});

describe('the multi-part draft goes where any score goes', () => {
  const { score } = mapStemsToScore(stems(), { id: 'audio-1', title: 'Band' });
  it('round-trips through MusicXML with every part', () => {
    const xml = scoreToMusicXml(score);
    const back = musicXmlToScore(xml, { id: 'rt' });
    expect(back.score.parts).toHaveLength(4);
    expect(back.score.parts.map((p) => p.staves.length)).toEqual([1, 2, 1, 1]);
    expect(back.score.bars).toHaveLength(score.bars.length);
  });
  it('renders to SVG without error', () => {
    const pages = renderScoreToSvg(score, {});
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.every((p) => p.svg.startsWith('<svg') || p.svg.includes('<svg'))).toBe(true);
  });
});

describe('part-level accuracy on the synthetic full band', () => {
  for (const level of JITTER_LEVELS.filter((l) => l !== 'unmarked')) {
    it(`reads every part at the ${level} level`, () => {
      const metrics = scoreStemsImport(truth, stems(level));
      const floor = level === 'clean' || level === 'light' ? 0.95 : level === 'medium' ? 0.85 : 0.6;
      for (const part of metrics.parts) expect(part.noteF1, `${part.name} at ${level}`).toBeGreaterThanOrEqual(floor);
    });
  }
});

describe('the audio project\'s four-stem mix (audio-mix4-*)', () => {
  const load = (name: string): NoteEvents =>
    parseNoteEvents(JSON.parse(readFileSync(new URL(`../fixtures/note-events/audio-mix4-${name}.json`, import.meta.url), 'utf8')));
  const mix = ['vocals', 'drums', 'bass', 'other'].map(load);
  const { score, diagnostics } = mapStemsToScore(mix, { id: 'audio-mix4' });

  it('lands one four-part score on one grid: voice, other (polyphonic), bass, drums', () => {
    expect(score.parts.map((p) => p.name)).toEqual(['Voice', 'Other', 'Bass', 'Drums']);
    expect(score.parts.map((p) => p.staves.length)).toEqual([1, 2, 1, 1]);
    expect(score.bars).toHaveLength(4);
    expect(score.meta.time).toEqual({ beats: 4, beatValue: 4 });
    expect(scoreMetrics(score).every((m) => m.valid)).toBe(true);
    expect(diagnostics.some((d) => d.startsWith('other: unsupported-instrument:'))).toBe(true);
  });

  it('keeps the chords of the other stem as stacked notes and renders', () => {
    const chords = score.parts[1]!.staves.flatMap((s) => s.bars.flatMap((b) => b.voices.flatMap((v) => v.items))).filter((i): i is Note => i.kind === 'note' && (i.stack?.length ?? 0) > 0);
    expect(chords.length).toBeGreaterThan(0);
    expect(renderScoreToSvg(score, {}).length).toBeGreaterThan(0);
    expect(musicXmlToScore(scoreToMusicXml(score), { id: 'rt' }).score.parts).toHaveLength(4);
  });
});
