import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  allStaves,
  barViews,
  isDrumKitStaff,
  mapNoteEventsToScore,
  parseNoteEvents,
  projectScore,
  reviewSummary,
  scoreMetrics,
} from '@sibei/model';
import type { Note, NoteEvents, Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';

/** Drum NoteEvents to a percussion-staff draft (ADR-0040, ADR-0041 slice 6). */

const load = (name: string): NoteEvents =>
  parseNoteEvents(JSON.parse(readFileSync(new URL(`../fixtures/note-events/${name}`, import.meta.url), 'utf8')));
const map = (name: string) => mapNoteEventsToScore(load(name), { id: 'import-1', title: 'Groove' });

const hitsOf = (score: Score, voice: number, bar: number): Note[] => {
  const staff = allStaves(score)[0]!;
  const voiceOfBar = staff.bars[bar - 1]!.voices.find((v) => v.index === voice);
  return (voiceOfBar?.items ?? []).filter((item): item is Note => item.kind === 'note');
};

describe('mapNoteEventsToScore for drums', () => {
  const draft = map('drums-rock-groove.json');
  const { score } = draft;

  it('makes one percussion staff that is a kit, with 4/4 and four bars', () => {
    expect(score.parts).toHaveLength(1);
    expect(allStaves(score)).toHaveLength(1);
    expect(allStaves(score)[0]!.type).toBe('percussion');
    expect(isDrumKitStaff(allStaves(score)[0]!)).toBe(true);
    expect(score.meta.time).toEqual({ beats: 4, beatValue: 4 });
    expect(score.bars).toHaveLength(4);
  });

  it('puts the hi-hat ostinato in voice 1, the kick in voice 2 and the snare, which shares moments with it, in voice 3', () => {
    expect(hitsOf(score, 1, 1).map((n) => n.drum)).toEqual(Array(8).fill('hihat'));
    expect(hitsOf(score, 2, 1).map((n) => n.drum)).toEqual(['kick', 'kick']);
    expect(hitsOf(score, 3, 1).map((n) => n.drum)).toEqual(['snare', 'snare']);
    // The snare sits on beats 2 and 4, the kick on 1 and 3: ticks 480 and 1440, 0 and 960.
    expect(hitsOf(score, 3, 1).map((n) => n.onset)).toEqual([480, 1440]);
    expect(hitsOf(score, 2, 1).map((n) => n.onset)).toEqual([0, 960]);
  });

  it('keeps the second kick of bar 2 on the and of 3 and writes each hit as long as the gap allows', () => {
    expect(hitsOf(score, 2, 2).map((n) => n.onset)).toEqual([0, 960, 1200]);
    expect(hitsOf(score, 2, 2).map((n) => n.duration.value)).toEqual([4, 8, 8]);
    expect(hitsOf(score, 1, 1).every((n) => n.duration.value === 8)).toBe(true);
  });

  it('reads drum_class (the open hat) over the key, and keeps the crash', () => {
    expect(hitsOf(score, 1, 3).map((n) => n.drum)).toContain('hihat-open');
    expect(hitsOf(score, 1, 4)[0]!.drum).toBe('crash');
  });

  it('keeps every bar metrically valid by construction', () => {
    expect(scoreMetrics(score).every((m) => m.valid)).toBe(true);
  });

  it('flags the uncertain hit and an unknown key for review, and says so in the diagnostics', () => {
    expect(reviewSummary(score).anythingFlagged).toBe(true);
    const lowConfidence = barViews(score)
      .flatMap((bar) => bar.items)
      .filter((item) => item.kind === 'note' && item.review.flagged && item.drum !== 'percussion');
    expect(lowConfidence.length).toBeGreaterThanOrEqual(1);
    const unknown = allStaves(score)[0]!.bars
      .flatMap((bar) => bar.voices.flatMap((voice) => voice.items))
      .find((item) => item.kind === 'note' && item.drum === 'percussion');
    expect(unknown).toBeDefined();
    expect(draft.diagnostics.some((d) => d.includes('unknown-drum') && d.includes('70'))).toBe(true);
    expect(draft.diagnostics.some((d) => d.includes('low_confidence_region'))).toBe(true);
  });

  it('prints drums by name in the text projection and renders to a page', () => {
    expect(projectScore(score)).toContain('hihat/8');
    expect(renderScoreToSvg(score)).toHaveLength(1);
  });

  it('maps a single bar of kick, snare and hi-hat, and is deterministic', () => {
    const a = map('drums-single-bar.json');
    const b = map('drums-single-bar.json');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(allStaves(a.score)[0]!.type).toBe('percussion');
    expect(a.score.bars.length).toBeGreaterThanOrEqual(1);
  });

  it('maps a document with no hits to one empty bar and keeps the warning', () => {
    const empty = { ...load('drums-single-bar.json'), notes: [] };
    const result = mapNoteEventsToScore(empty, { id: 'e' });
    expect(result.score.bars).toHaveLength(1);
    expect(result.diagnostics.join(' ')).toContain('no-notes');
  });
});
