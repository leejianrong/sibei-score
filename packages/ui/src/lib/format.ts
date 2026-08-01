import type { MusicFontName } from '@sibei/engrave';
import type { Paper } from '@sibei/layout';

/**
 * Display formatting. Nothing musical decided here — a key's spelling comes from
 * `formatKeySignature` in the model and this only chooses how to draw the accidental.
 */

/** `Db` -> `D♭`, `F#m` -> `F♯m`. The typographic accidentals, on screen only. */
export function displayKey(key: string): string {
  return key.replaceAll('b', '♭').replaceAll('#', '♯');
}

/** `A4`, `Letter`. Falls back to the raw name so a paper added later still gets a label. */
export function paperLabel(paper: Paper): string {
  if (paper === 'a4') return 'A4';
  return paper.charAt(0).toUpperCase() + paper.slice(1);
}

/** The faces keep their own names — `normal` and `jazz` are what the API and the CLI call them. */
export function fontLabel(font: MusicFontName): string {
  return font;
}

/** `2026-08-01T10:20:13Z` -> `2026-08-01 10:20:13 UTC`. The machine register, unabbreviated. */
export function absoluteTime(iso: string): string {
  return iso.replace('T', ' ').replace('Z', ' UTC');
}

/**
 * `24 min ago`, `2 hours ago`, `3 days ago`. The library's column, where "when did I last touch
 * this" is the question and a timestamp to the second is noise. The score rail prints the exact
 * one, because by then you are looking at one chart.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;

  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${plural(hours, 'hour')} ago`;

  const days = Math.round(hours / 24);
  return `${days} ${plural(days, 'day')} ago`;
}

/**
 * The bars a review note points at, compacted into runs: `bar 1 – bar 32`, `bars 2, 9`,
 * `bars 1–3, 7–9`.
 *
 * A blank 32-bar chart flags every bar it has (every empty bar is under the meter, ADR-0013), so
 * the unabridged list is 32 numbers and says nothing a range does not. Long lists are truncated
 * rather than allowed to push the rail's other blocks off the screen.
 */
export function formatBarRanges(bars: readonly number[], maxRuns = 5): string {
  if (bars.length === 0) return '';

  const runs: [number, number][] = [];
  for (const bar of [...bars].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last !== undefined && bar === last[1] + 1) last[1] = bar;
    else runs.push([bar, bar]);
  }

  const first = runs[0];
  if (runs.length === 1 && first !== undefined) {
    return first[0] === first[1] ? `bar ${first[0]}` : `bar ${first[0]} – bar ${first[1]}`;
  }

  const shown = runs.slice(0, maxRuns).map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`));
  const hidden = runs.length - shown.length;
  return `bars ${shown.join(', ')}${hidden > 0 ? `, +${hidden} more` : ''}`;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
