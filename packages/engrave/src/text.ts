import type { LayoutText, LayoutTextRole } from '@sibei/layout';
import { formatRoot, parseChord } from '@sibei/music';
import type { Alteration, ChordStructure } from '@sibei/music';
import type { SvgElement } from './svg.js';
import { el, textEl } from './svg.js';

/**
 * Page text: the title block, bar numbers, rehearsal marks and chord symbols.
 *
 * Everything here is placed with `text-anchor` and **never measured**. Centring text by
 * measuring it needs `getBBox`, which only a real browser implements, so a server render
 * would place text differently from the screen — and ADR-0015 requires those cannot
 * drift. `text-anchor` moves the alignment into the SVG, where both agree by
 * construction. `packages/draw/src/text.ts` reached the same conclusion for the other
 * adapter, and it is the reason neither ever asks how wide a string is.
 */

const SERIF = 'Times New Roman, serif';

const ANCHOR = { left: 'start', center: 'middle', right: 'end' } as const;

export type TextAlign = keyof typeof ANCHOR;

export interface TextStyle {
  family: string;
  weight: string;
  style: string;
}

export function styleForRole(role: LayoutTextRole): TextStyle {
  switch (role) {
    case 'title':
      return { family: SERIF, weight: 'bold', style: 'normal' };
    case 'composer':
    case 'style':
      return { family: SERIF, weight: 'normal', style: 'italic' };
  }
}

export interface TextSpec {
  text: string;
  x: number;
  /** Baseline. */
  y: number;
  size: number;
  align: TextAlign;
  family?: string;
  weight?: string;
  style?: string;
  class?: string;
}

export function text(spec: TextSpec): SvgElement {
  return textEl(
    {
      class: spec.class ?? 'se-text',
      x: spec.x,
      y: spec.y,
      'font-family': spec.family ?? SERIF,
      'font-size': `${spec.size}px`,
      'font-weight': spec.weight ?? 'normal',
      'font-style': spec.style ?? 'normal',
      'text-anchor': ANCHOR[spec.align],
      fill: '#000000',
      stroke: 'none',
    },
    [spec.text],
  );
}

export function headerText(item: LayoutText): SvgElement {
  const style = styleForRole(item.role);
  return text({
    text: item.text,
    x: item.x,
    y: item.y,
    size: item.size,
    align: item.align,
    class: `se-${item.role}`,
    ...style,
  });
}

// ---------------------------------------------------------------------------
// Chord symbols
// ---------------------------------------------------------------------------

/**
 * Jazz chord typography, driven by the grammar (V5, ADR-0012, ADR-0030). The root and a slash
 * bass sit at full size on the baseline; the quality glyph — `Δ` for a major seventh, `ø` for a
 * half-diminished chord, `°` for a diminished one, `m`/`+` for minor and augmented — sits at full
 * size too; and the tensions ride as a superscript. Altered degrees are parenthesised, and two or
 * more of them stack vertically the way a reader expects them (`♯11` over `♭9`).
 *
 * This *understands* the text now rather than splitting it on a regex. `parseChord` turns
 * `Ebmaj7` into a structure, and it is that structure — not the characters — that decides `Δ7`.
 * Text the grammar cannot read (and a `plain` annotation, Q56) is drawn verbatim and unsplit:
 * superscripting half of `solo break` would be worse than leaving it whole. `N.C.` parses to a
 * no-chord marking and is likewise drawn as written.
 *
 * Nothing here is measured (ADR-0015). The one place width matters — sliding a stacked alteration
 * back under the one above it — uses a character-count estimate, the same technique `rehearsalMark`
 * uses to size its box, never `getBBox`.
 */
const SUPERSCRIPT_RISE = 0.42;
const SUPERSCRIPT_SCALE = 0.72;
/** A stacked alteration's own size and the drop to the line beneath it, as fractions of the size. */
const STACK_SCALE = 0.72;
const STACK_LINE = 0.82;
/** Rough advance per superscript character, for sliding a stacked run back. Digits are narrow. */
const STACK_ADVANCE = 0.5;
/** Music accidentals as glyphs, so `♯11` reads as an alteration rather than a hash. */
const SHARP = '♯';
const FLAT = '♭';

export interface ChordSpec {
  text: string;
  x: number;
  y: number;
  size: number;
  /** Free text — an instruction, or something the recogniser could not read (Q56). */
  plain: boolean;
}

export function chordSymbol(spec: ChordSpec): SvgElement {
  const attrs = {
    class: spec.plain ? 'se-annotation' : 'se-chord',
    x: spec.x,
    y: spec.y,
    'font-family': SERIF,
    'font-size': `${spec.size}px`,
    'font-weight': 'normal',
    'font-style': 'normal',
    // Chord symbols are left-aligned to their note, as V1 settled.
    'text-anchor': 'start',
    fill: '#000000',
    stroke: 'none',
  };

  const parsed = spec.plain ? null : parseChord(spec.text);
  if (parsed === null || parsed.kind === 'no-chord') {
    // `N.C.`, a plain annotation, or text the grammar cannot read: verbatim and unsplit.
    return textEl(attrs, [spec.text]);
  }

  return textEl(attrs, chordRuns(parsed.structure, spec.size));
}

/** The ordered runs of one engraved chord: baseline root + quality, a superscript, a slash bass. */
function chordRuns(s: ChordStructure, size: number): (SvgElement | string)[] {
  const runs: (SvgElement | string)[] = [formatRoot(s.root)];

  const quality = baselineQuality(s);
  if (quality !== '') runs.push(quality);

  const alterations = shownAlterations(s);
  const lead = superscriptLead(s);
  // Two or more alterations with nothing after them stack; otherwise they ride inline in parens.
  if (alterations.length >= 2 && s.bass === null) {
    runs.push(...stackedSuperscript(lead, alterations, size));
  } else {
    const parenthesised = alterations.length === 0 ? '' : `(${alterations.map(formatAlteration).join('')})`;
    const raised = `${lead}${parenthesised}`;
    if (raised !== '') runs.push(superscript(raised, size));
  }

  // The slash and the bass stay at full size: a superscripted bass reads as an extension.
  if (s.bass !== null) runs.push(`/${formatRoot(s.bass)}`);
  return runs;
}

/**
 * The full-size glyphs after the root: `m`, `+`, `°`, `ø`, and the `Δ` of a major seventh. A
 * half-diminished chord is `ø` alone — the `m` and the `♭5` are what `ø` *means*, so drawing them
 * too would be saying it twice (that `♭5` is dropped in `shownAlterations`).
 */
function baselineQuality(s: ChordStructure): string {
  if (isHalfDiminished(s)) return 'ø';
  let out = '';
  if (s.triad === 'minor') out += 'm';
  else if (s.triad === 'augmented') out += '+';
  else if (s.triad === 'diminished') out += '°';
  if (s.seventh === 'major') out += 'Δ';
  return out;
}

/** The superscript number: the extension or seventh, a sixth, the `alt` shorthand, a suspension. */
function superscriptLead(s: ChordStructure): string {
  if (s.alt) return '7alt';
  const top = s.seventh !== null ? String(s.extension ?? 7) : s.sixth ? '6' : s.power ? '5' : '';
  return s.suspension === null ? top : `${top}${s.suspension}`;
}

function shownAlterations(s: ChordStructure): Alteration[] {
  return isHalfDiminished(s)
    ? s.alterations.filter((a) => !(a.degree === 5 && a.alter === -1))
    : s.alterations;
}

function isHalfDiminished(s: ChordStructure): boolean {
  return (
    s.triad === 'minor' &&
    s.seventh === 'minor' &&
    s.alterations.some((a) => a.degree === 5 && a.alter === -1)
  );
}

function formatAlteration(a: Alteration): string {
  return `${a.alter < 0 ? FLAT : SHARP}${a.degree}`;
}

/**
 * A raised run. `dy` and a smaller `font-size` rather than `baseline-shift`, because
 * `baseline-shift` is inconsistently supported by SVG rasterisers and this is not.
 */
function superscript(value: string, size: number): SvgElement {
  return {
    name: 'tspan',
    attrs: {
      'font-size': `${round(size * SUPERSCRIPT_SCALE)}px`,
      dy: -round(size * SUPERSCRIPT_RISE),
    },
    children: [],
    text: [value],
  };
}

/**
 * The lead and the first alteration on one raised line, then the remaining alterations stacked
 * beneath the first — each slid left by an estimate of the run above it so their left edges line
 * up. Only reached when there is no bass, so nothing has to resume after the stack.
 */
function stackedSuperscript(lead: string, alterations: Alteration[], size: number): SvgElement[] {
  const scaled = size * STACK_SCALE;
  const first = alterations[0] as Alteration;
  const top = `${lead}${formatAlteration(first)}`;

  const runs: SvgElement[] = [
    {
      name: 'tspan',
      attrs: { 'font-size': `${round(scaled)}px`, dy: -round(size * SUPERSCRIPT_RISE) },
      children: [],
      text: [top],
    },
  ];

  let previous = formatAlteration(first);
  for (const alteration of alterations.slice(1)) {
    const text = formatAlteration(alteration);
    runs.push({
      name: 'tspan',
      attrs: {
        'font-size': `${round(scaled)}px`,
        dy: round(scaled * STACK_LINE),
        dx: -round(previous.length * scaled * STACK_ADVANCE),
      },
      children: [],
      text: [text],
    });
    previous = text;
  }
  return runs;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

/**
 * A rehearsal letter, boxed the way a reader expects to find one.
 *
 * `top` is the top of the band layout reserved for the mark, not the letter's baseline:
 * the padding around the letter is this function's invention, so it is this function that
 * has to allow for it. Taking a baseline instead put the box's top edge `padY` above the
 * band and so above the system — which page 1 hides inside the title block's reserved
 * height, and page 2 puts in the top margin (V3b).
 */
export function rehearsalMark(value: string, x: number, top: number, size: number): SvgElement[] {
  const padX = size * 0.4;
  const padY = size * 0.28;
  // The box is sized from the font size and the letter count rather than from a
  // measurement, for the same reason nothing else here is measured.
  const width = size * 0.72 * value.length + padX * 2;
  const height = size + padY * 2;

  return [
    el('rect', {
      class: 'se-rehearsalbox',
      x,
      y: top,
      width,
      height,
      fill: 'none',
      stroke: '#000000',
      'stroke-width': 1,
    }),
    text({
      text: value,
      x: x + width / 2,
      y: top + padY + size,
      size,
      align: 'center',
      weight: 'bold',
      class: 'se-rehearsalmark',
    }),
  ];
}
