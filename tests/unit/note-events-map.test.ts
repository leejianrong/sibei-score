import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  barMetrics,
  formatKeySignature,
  mapNoteEventsToScore,
  parseNoteEvents,
  projectScore,
  reviewSummary,
  splitTicks,
  type NoteEvents,
} from '@sibei/model';

const load = (name: string): NoteEvents =>
  parseNoteEvents(JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'note-events', name), 'utf8')));
const map = (name: string) => mapNoteEventsToScore(load(name), { id: 'import-1', title: 'T' });

describe('mapNoteEventsToScore (ADR-0040)', () => {
  it('drafts the Ode to Joy fixture: C major, 4/4, spelled, metrically valid', () => {
    const { score } = map('voice-ode-beats.json');
    expect(formatKeySignature(score.meta.key)).toBe('C');
    expect(score.meta.time).toEqual({ beats: 4, beatValue: 4 });
    expect(score.bars).toHaveLength(4);
    for (const bar of score.bars) expect(barMetrics(bar, score.meta.time).valid).toBe(true);
    const text = projectScore(score);
    expect(text).toContain('e4/4');
    expect(reviewSummary(score).invalidBars).toEqual([]);
  });

  it('flags a low-confidence note and shows it in the text projection', () => {
    const { score } = map('bass-walking-beats.json');
    const flagged = score.bars.flatMap((b) => b.items).filter((i) => i.review.flagged);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.confidence).toBeCloseTo(0.41);
    expect(projectScore(score)).toContain('!41');
  });

  it('keeps document warnings as diagnostics', () => {
    const { diagnostics } = map('bass-walking-beats.json');
    expect(diagnostics.some((d) => d.startsWith('low_confidence_region:'))).toBe(true);
    expect(diagnostics.some((d) => d.startsWith('inferred:'))).toBe(true);
  });

  it('flags bar 1 when the barring is a guess (no beat grid, or null downbeats)', () => {
    const noGrid = map('voice-twinkle-no-beats.json').score;
    expect(noGrid.bars[0]!.review.flagged).toBe(true);
    expect(noGrid.bars[1]!.review.flagged).toBe(false);

    const real = load('valid_bass_line.json');
    for (const b of real.beats) b.is_downbeat = null;
    const draft = mapNoteEventsToScore(real, { id: 'import-2' });
    expect(draft.score.bars[0]!.review.flagged).toBe(true);
    expect(draft.diagnostics.some((d) => d.startsWith('no-downbeats:'))).toBe(true);
  });

  it('does not flag bar 1 when the grid marks downbeats', () => {
    expect(map('voice-ode-beats.json').score.bars[0]!.review.flagged).toBe(false);
  });

  it('maps a silent document to an empty draft, not an error', () => {
    const { score, diagnostics } = map('valid_silent_voice.json');
    expect(score.bars).toHaveLength(1);
    expect(score.bars[0]!.items).toEqual([]);
    expect(diagnostics[0]).toBe('silent_input: no audible signal in the input');
  });

  it('ties a note across the bar line', () => {
    const doc = load('voice-ode-beats.json');
    doc.notes = [{ id: 'a', onset_s: 1.5, offset_s: 2.45, pitch: 60, confidence: 0.9 }];
    doc.beats = Array.from({ length: 8 }, (_, i) => ({ t_s: i * 0.5, is_downbeat: i % 4 === 0 }));
    const { score } = mapNoteEventsToScore(doc, { id: 'x' });
    const [a, b] = score.bars;
    expect(a!.items.at(-1)).toMatchObject({ kind: 'note', tie: 'start' });
    expect(b!.items[0]).toMatchObject({ kind: 'note', tie: 'stop' });
  });

  it('is deterministic', () => {
    expect(map('bass-walking-beats.json')).toEqual(map('bass-walking-beats.json'));
  });
});

describe('splitTicks', () => {
  it('keeps one legal note where it can and ties where it cannot', () => {
    expect(splitTicks(0, 960)).toEqual([{ value: 2, dots: 0 }]);
    expect(splitTicks(0, 720)).toEqual([{ value: 4, dots: 1 }]);
    // a half note may not start on beat 2: quarter, then a half on beat 3
    expect(splitTicks(480, 1440)).toEqual([{ value: 4, dots: 0 }, { value: 2, dots: 0 }]);
    // a quarter may start on the half-beat (syncopation)
    expect(splitTicks(240, 480)).toEqual([{ value: 4, dots: 0 }]);
    expect(splitTicks(0, 600).map((d) => d.value)).toEqual([4, 16]);
  });
});
