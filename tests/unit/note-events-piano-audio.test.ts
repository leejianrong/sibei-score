import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allStaves, mapNoteEventsToScore, parseNoteEvents, pitchToMidi } from '@sibei/model';
import type { Note, Score } from '@sibei/model';

/**
 * The audio project's piano pair (their PR #8): a seeded two-handed clip (left hand below MIDI 55) as ground truth and
 * as their classical baseline's imperfect output on the same audio. Our hand split is not told that threshold; this
 * measures how close the adaptive rule lands to it (ADR-0040 piano amendment, SIB2-144).
 */

const load = (name: string) => parseNoteEvents(JSON.parse(readFileSync(new URL(`../fixtures/note-events/${name}`, import.meta.url), 'utf8')));

/** Every sounding MIDI pitch on each staff of the first part (tied continuations count once per piece), in staff order. */
function pitchesByStaff(score: Score): number[][] {
  return allStaves(score).map((staff) => {
    const out: number[] = [];
    for (const bar of staff.bars)
      for (const voice of bar.voices)
        for (const item of voice.items) {
          if (item.kind !== 'note') continue;
          const note = item as Note;
          out.push(pitchToMidi(note.pitch));
          for (const extra of note.stack ?? []) out.push(pitchToMidi(extra.pitch));
        }
    return out;
  });
}

describe('the audio project piano fixtures', () => {
  it('splits the ground-truth clip exactly along the recipe hands', () => {
    const { score } = mapNoteEventsToScore(load('audio-piano-truth.json'), { id: 'truth' });
    const [right, left] = pitchesByStaff(score);
    expect(right!.length).toBeGreaterThan(0);
    expect(left!.length).toBeGreaterThan(0);
    expect(right!.filter((m) => m < 55)).toEqual([]);
    expect(left!.filter((m) => m >= 55)).toEqual([]);
  });

  it('stays close to the recipe split on the noisy baseline output', () => {
    const { score, diagnostics } = mapNoteEventsToScore(load('audio-piano-baseline.json'), { id: 'baseline' });
    const [right, left] = pitchesByStaff(score);
    const total = right!.length + left!.length;
    const opposite = right!.filter((m) => m < 55).length + left!.filter((m) => m >= 55).length;
    expect(total).toBeGreaterThan(0);
    // Measured 4 of 82 on this clip (about 5%); the bound leaves headroom without hiding a regression.
    expect(opposite / total).toBeLessThan(0.1);
    expect(diagnostics.some((d) => d.startsWith('hand-split:'))).toBe(true);
  });
});
