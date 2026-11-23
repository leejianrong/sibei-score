import { CLIP_FORMAT, barCapacity, clipProblem, formatBeat, beatOfOnset } from '@sibei/model';
import type { Clip, Score } from '@sibei/model';
import type { Operation } from './api.js';
import type { Lane } from './lanes.js';
import { qualifierOf } from './lanes.js';

/**
 * The browser's clipboard for copied music (SIB2-279). A clip is the same JSON `sbscore range copy` prints, so what is
 * copied here can be pasted by the CLI or an agent, and the reverse. It is held in memory (module-level, so it survives
 * opening another chart) and also written to the system clipboard as text when the browser allows.
 */

let held: Clip | null = null;

export const clipboard = {
  get(): Clip | null {
    return held;
  },
  set(clip: Clip | null): void {
    held = clip;
  },
};

/** The clip a system-clipboard text holds, or null when it is anything else (an ordinary paste of text). */
export function parseClipText(text: string): Clip | null {
  if (!text.includes(CLIP_FORMAT)) return null;
  try {
    const value: unknown = JSON.parse(text);
    return clipProblem(value) === null ? (value as Clip) : null;
  } catch {
    return null;
  }
}

export function clipText(clip: Clip): string {
  return JSON.stringify(clip);
}

/** The op that lays a clip at a bar and onset of a lane. The address carries the staff and voice when the chart needs them. */
export function pasteOp(score: Score, clip: Clip, at: { lane: Lane; bar: number; onset: number }): Operation {
  const beat = formatBeat(beatOfOnset(at.onset, score.meta.time));
  return { type: 'range.paste', target: `${qualifierOf(score, at.lane)}bar${at.bar}.beat${beat}`, payload: { clip } };
}

/** `3 notes`, `2 bars` for the status line. */
export function clipSummary(clip: Clip, time: Score['meta']['time']): string {
  const bars = clip.ticks / barCapacity(time);
  const notes = clip.voices.reduce((count, voice) => count + voice.items.filter((item) => item.kind === 'note').length, 0);
  const span = Number.isInteger(bars) ? `${bars} bar${bars === 1 ? '' : 's'}` : `${clip.ticks} ticks`;
  return `${notes} note${notes === 1 ? '' : 's'}, ${span}`;
}
