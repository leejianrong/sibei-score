import { beatOfOnset, tupletOf } from './duration.js';
import { formatKeySignature, formatPitch } from './pitch.js';
import { orderedItems } from './address.js';
import { barReview, NEEDS_REVIEW, reviewSummary } from './review.js';
import type { Bar, BarItem, Score, TimeSignature } from './score.js';

/**
 * The agent-facing text projection (ADR-0009). A **contract**, not ad-hoc formatting: agents will
 * depend on it, so it has its own tests and it changes deliberately.
 *
 * Compact and lossy by design. The point is that an agent can grasp harmonic shape and form from a
 * few hundred tokens instead of tens of thousands of MusicXML (R2). Anything not representable here
 * must still be reachable through the structured dump, and this must never be the only way to see
 * something.
 *
 * Four-bar rows, matching the printed layout. A strictly line-per-bar format would be easier to
 * parse and was rejected anyway, because the four-bar grouping is what a reader — human or model —
 * takes structure from.
 *
 * **It prints the addresses the CLI accepts** (ADR-0007). That is the design principle the whole
 * addressing scheme rests on: reading the projection teaches an agent how to write one, so it never
 * has to guess or construct an address. Which means the `nK` labels here and
 * `resolveAddress(score, 'barN.nK')` must agree, including about rests taking a slot. There is a
 * test that walks every printed address back through the resolver.
 */

/** Bars per row. The printed layout's grid (ADR-0015). */
const BARS_PER_ROW = 4;

/** Minimum width of a bar's cell on the chord line. Wide enough for two symbols and a gap. */
const MIN_CELL = 9;

export interface ProjectionOptions {
  /** Bars per row. Only for a test that wants a narrower grid; the default is the printed one. */
  barsPerRow?: number;
}

export function projectScore(score: Score, options: ProjectionOptions = {}): string {
  const perRow = options.barsPerRow ?? BARS_PER_ROW;
  const lines: string[] = [header(score)];

  // The wording lives in `review.ts`, not here, because the score rail says the same sentence
  // (V4b): the engraver draws no flag, so the chrome carries review state and must carry it in
  // the projection's own vocabulary rather than inventing a second one.
  const review = reviewSummary(score);
  if (review.anythingFlagged) {
    lines.push(`  ! = ${NEEDS_REVIEW}${review.meterNote === null ? '' : ` · ${review.meterNote}`}`);
  }
  lines.push('');

  const pickup = score.bars.find((bar) => bar.number === 0);
  if (pickup !== undefined) {
    // A pickup sits outside the four-bar grid, the same way it does on the page (ADR-0015).
    lines.push(...rowFor([pickup], score, 'pickup'));
  }

  const grid = score.bars.filter((bar) => bar.number !== 0);
  for (let at = 0; at < grid.length; at += perRow) {
    lines.push(...rowFor(grid.slice(at, at + perRow), score));
  }

  if (grid.length === 0 && pickup === undefined) lines.push('  (no bars)');

  lines.push('');
  lines.push(...legend(score));
  return lines.join('\n');
}

function header(score: Score): string {
  const { title, composer, key, time, style } = score.meta;
  const bars = score.bars.filter((bar) => bar.number !== 0).length;
  // An unnamed chart is now the state a plain `sbscore new` leaves behind (KAN-594), so the title
  // is omitted the way the composer and the style line already are, rather than printed as an empty
  // cell that leaves a leading em-dash on the line. The header degrades to the key, meter and
  // length, which is the same set the printed page shows when its title band collapses (KAN-525).
  const parts = title === '' ? [] : [title];
  if (composer !== '') parts.push(composer);
  parts.push(`key ${formatKeySignature(key)}, ${time.beats}/${time.beatValue}, ${bars} bars`);
  if (style !== null && style !== '') parts.push(style);
  return parts.join(' — ');
}

/** One four-bar row: the chord line, then a melody line per bar that has anything in it. */
function rowFor(bars: Bar[], score: Score, label?: string): string[] {
  const first = bars[0];
  if (first === undefined) return [];

  const gutter = label ?? String(first.number);
  const lines = [`${gutter.padStart(2)} ${chordLine(bars, score.meta.time)}`];

  for (const bar of bars) {
    const melody = melodyLine(bar, score.meta.time);
    // An empty bar prints no melody line. The chord grid above already shows that it exists, and a
    // blank 32-bar chart would otherwise be 32 lines of nothing — which is the opposite of compact.
    if (melody !== null) lines.push(`   ${melody}`);
  }
  return lines;
}

/**
 * `|Ebm7      Bb7       |Ebm7  Ab7 |`. Chord symbols carry beat placement, because where in the bar
 * a chord falls is musical information and not layout.
 */
function chordLine(bars: Bar[], time: TimeSignature): string {
  return `${bars.map((bar) => cell(bar, time)).join('')}|`;
}

/**
 * One bar's chord cell.
 *
 * Each symbol wants the column its beat implies, and gets it *unless* the symbol before it is still
 * in the way — in which case it is pushed right by however much it takes, and the cell widens. The
 * first version computed a width and then placed into it, and the two calculations disagreed: bar 10
 * of the nasty chart came out as `F#m7bB7`, two chords fused into one nonsense symbol. Placing first
 * and measuring afterwards cannot do that.
 *
 * Beat placement therefore degrades gracefully rather than breaking: with room it is exact, and
 * without room the order is still right and nothing is lost.
 */
function cell(bar: Bar, time: TimeSignature): string {
  const chords = [...bar.chords].sort((a, b) => a.onset - b.onset);
  const placed: { at: number; text: string }[] = [];
  let cursor = 0;

  for (const chord of chords) {
    const text = `${chord.text}${chord.review.flagged ? '!' : ''}`;
    const wanted = Math.round(((beatOfOnset(chord.onset, time) - 1) / time.beats) * MIN_CELL);
    const at = Math.max(wanted, cursor);
    placed.push({ at, text });
    // One space minimum after every symbol, so two never read as one.
    cursor = at + text.length + 1;
  }

  const width = Math.max(MIN_CELL, cursor === 0 ? 0 : cursor - 1);
  const slots = Array.from({ length: width }, () => ' ');
  for (const { at, text } of placed) {
    for (let offset = 0; offset < text.length; offset += 1) slots[at + offset] = text[offset] ?? ' ';
  }
  return `|${slots.join('')}`;
}

/** `bar2  n1 gb5/2  n2 f5/4 !`, or null when the bar holds nothing. */
function melodyLine(bar: Bar, time: TimeSignature): string | null {
  const items = orderedItems(bar);
  if (items.length === 0) return null;

  // `barReview`, not `bar.review`: the `!` and the header's count line must be the same fact, and
  // reading the stored flag here made them two (KAN-597). The chord and item `!` below stay stored,
  // because nothing can derive a chord's `unparsed-chord` or a note's `low-confidence`.
  const label = `bar${bar.number}${barReview(bar, time).flagged ? '!' : ''}`;
  const parts = items.map((item, index) => `n${index + 1} ${describe(item, bar)}`);
  return `${label.padEnd(7)}${parts.join('  ')}`;
}

/**
 * One item: `eb5/8`, `~db5/4.~`, `r/4`, `c5/8(3)`, each followed by `!` when flagged.
 *
 * Lower case for pitches, following ADR-0009's own example — it keeps a melody line from shouting,
 * and a chord symbol above it stays the thing that is capitalised.
 */
function describe(item: BarItem, bar: Bar): string {
  const tie = item.kind === 'note' ? item.tie : 'none';
  const opens = tie === 'stop' || tie === 'both';
  const closes = tie === 'start' || tie === 'both';

  const body = item.kind === 'note' ? formatPitch(item.pitch).toLowerCase() : 'r';
  const tuplet = tupletOf(item.id, bar);
  const ratio =
    tuplet === null ? '' : tuplet.actual === 3 && tuplet.normal === 2 ? '(3)' : `(${tuplet.actual}:${tuplet.normal})`;

  return `${opens ? '~' : ''}${body}/${value(item)}${ratio}${closes ? '~' : ''}${item.review.flagged ? ' !' : ''}`;
}

/** `8`, `4.`, `2..` — the note value, then a dot per dot. */
function value(item: BarItem): string {
  return `${item.duration.value}${'.'.repeat(item.duration.dots)}`;
}

/**
 * The legend, built from a real object in this score rather than from a made-up example. Reading it
 * is how an agent learns the address forms, so it is worth being concrete.
 */
function legend(score: Score): string[] {
  for (const bar of score.bars) {
    const items = orderedItems(bar);
    const second = items[1] ?? items[0];
    if (second === undefined) continue;
    const ordinal = items.indexOf(second) + 1;
    const beat = beatOfOnset(second.onset, score.meta.time);
    return [
      `Address: bar${bar.number}.n${ordinal}  or  bar${bar.number}.beat${trim(beat)}  or  ${second.id}`,
      'Onsets only: a beat with nothing on it is an error listing the bar’s real onsets.',
    ];
  }
  return [
    'Address: bar1.n1  or  bar1.beat1  or  an id like note-17',
    'Onsets only: a beat with nothing on it is an error listing the bar’s real onsets.',
  ];
}

function trim(beat: number): string {
  return Number(beat.toFixed(4)).toString();
}
