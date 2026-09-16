import type { LayoutText, LayoutTextRole } from '@sibei/layout';
import { formatAlter } from '@sibei/model';
import { parseChord } from '@sibei/music';
import type { Alteration, ChordStructure, Root } from '@sibei/music';
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

/**
 * The text font a default render uses. Threaded through the header and chord symbols as
 * `EngraveOptions.textFont`, so a corpus can render the same score in a variety of typefaces
 * (V17a domain randomisation) while a plain render stays on the serif every surface used
 * before. Bar numbers and rehearsal marks stay on the serif — they are not recognition targets.
 */
export const DEFAULT_TEXT_FONT = SERIF;

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

export function headerText(item: LayoutText, family?: string): SvgElement {
  const style = styleForRole(item.role);
  return text({
    text: item.text,
    x: item.x,
    y: item.y,
    size: item.size,
    align: item.align,
    class: `se-${item.role}`,
    ...style,
    // A varied render swaps the family but keeps the role's weight/style (a title stays bold).
    ...(family === undefined ? {} : { family }),
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
 * **Symbology is a style (V17a).** Which glyph a quality draws — `Δ` vs the word `maj`, `ø` vs a
 * spelled `m7♭5`, `°` vs `dim`, `+` vs `aug`, a `♭`/`♯` glyph vs an ASCII `b`/`#` — is a
 * `ChordStyle` the caller chooses, so the OMR training corpus can render the same chord the many
 * ways real charts print it (domain randomisation, ADR-0031). The `Chord` model's `.text` stays
 * the one canonical ASCII spelling (ADR-0012); the *typography* varies here. `CANONICAL_CHORD_STYLE`
 * reproduces exactly what every surface drew before the knob existed, so a plain render is
 * byte-identical (ADR-0014/0015). `chordGlyphText` returns the string this actually draws for a
 * style, so a recogniser's label is read from the same code that inked the pixels — they cannot drift.
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

/** How a major seventh is marked: the `Δ` glyph, or the word spelled `maj` / `ma` / `M`. */
export type MajorSeventhGlyph = 'delta' | 'maj' | 'ma' | 'M';
/** How a minor triad is marked. */
export type MinorGlyph = 'm' | 'min' | 'dash';
/** A half-diminished chord as the `ø` glyph, or spelled out as an ordinary `m7♭5`. */
export type HalfDiminishedGlyph = 'circle' | 'spell';
/** A diminished triad as the `°` glyph, or the word `dim`. */
export type DiminishedGlyph = 'circle' | 'dim';
/** An augmented triad as the `+` glyph, or the word `aug`. */
export type AugmentedGlyph = 'plus' | 'aug';
/** Accidentals as the `♭`/`♯` glyphs, or plain ASCII `b`/`#`. */
export type AccidentalGlyph = 'ascii' | 'glyph';

/**
 * The typographic choices for one chord render. Every field varies a real-world spelling of the
 * same structure; `CANONICAL_CHORD_STYLE` is the one every surface used before V17a.
 */
export interface ChordStyle {
  majorSeventh: MajorSeventhGlyph;
  minor: MinorGlyph;
  halfDiminished: HalfDiminishedGlyph;
  diminished: DiminishedGlyph;
  augmented: AugmentedGlyph;
  /** The accidental in a root or slash-bass (`E♭` vs `Eb`). */
  rootAccidental: AccidentalGlyph;
  /** The accidental in an altered tension (`♭9` vs `b9`). */
  tensionAccidental: AccidentalGlyph;
  /** Parenthesise inline altered tensions — `C7(♭9)` vs `C7♭9`. */
  parenthesizeAlterations: boolean;
  /** Stack two-or-more alterations vertically (a bassless chord) rather than run them inline. */
  stackAlterations: boolean;
  /** The `Δ` glyph's size relative to the chord size; `1` draws it inline at full size. */
  triangleScale: number;
}

/**
 * The style every surface drew before the knob existed: `Δ`/`ø`/`°`/`+` glyphs, a full-size
 * triangle, ASCII accidentals in the root and `♭`/`♯` glyphs in the tensions (the historical
 * asymmetry), inline alterations parenthesised, two-or-more stacked. A render with this style is
 * byte-identical to the pre-V17a output (ADR-0014/0015).
 */
export const CANONICAL_CHORD_STYLE: ChordStyle = {
  majorSeventh: 'delta',
  minor: 'm',
  halfDiminished: 'circle',
  diminished: 'circle',
  augmented: 'plus',
  rootAccidental: 'ascii',
  tensionAccidental: 'glyph',
  parenthesizeAlterations: true,
  stackAlterations: true,
  triangleScale: 1,
};

export interface ChordSpec {
  text: string;
  x: number;
  y: number;
  size: number;
  /** Free text — an instruction, or something the recogniser could not read (Q56). */
  plain: boolean;
  /** Typographic style; defaults to the canonical one every surface used before V17a. */
  style?: ChordStyle;
  /** Text font family; defaults to the serif every surface used before V17a. */
  family?: string;
}

export function chordSymbol(spec: ChordSpec): SvgElement {
  const attrs = {
    class: spec.plain ? 'se-annotation' : 'se-chord',
    x: spec.x,
    y: spec.y,
    'font-family': spec.family ?? SERIF,
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

  const style = spec.style ?? CANONICAL_CHORD_STYLE;
  return textEl(attrs, chordParts(parsed.structure, spec.size, style).runs);
}

/**
 * The plain string a given style draws for a chord — its root, quality glyphs and tensions run
 * together in reading order (`Ebmaj7` → `EbΔ7`, or `Ebmaj7` under a spelled style). This is the
 * label a chord-band recogniser is trained against (V17b): it is produced by the *same* builder
 * that emits the SVG runs, so what the model learns to read is exactly what was inked. A `plain`
 * annotation or unparseable text is returned verbatim, as it is drawn.
 */
export function chordGlyphText(
  chordText: string,
  style: ChordStyle = CANONICAL_CHORD_STYLE,
): string {
  const parsed = parseChord(chordText);
  if (parsed === null || parsed.kind === 'no-chord') return chordText;
  // Size only scales the runs; the label is size-independent, so any size does.
  return chordParts(parsed.structure, 14, style).label;
}

/**
 * The ordered runs of one engraved chord AND the plain string they spell, built together so a
 * recogniser's label cannot drift from the pixels. Runs are a mix of baseline strings (drawn at
 * the parent size) and raised/scaled tspans.
 */
function chordParts(
  s: ChordStructure,
  size: number,
  style: ChordStyle,
): { runs: (SvgElement | string)[]; label: string } {
  const runs: (SvgElement | string)[] = [];
  let label = '';
  const push = (run: string): void => {
    runs.push(run);
    label += run;
  };

  push(formatRootStyled(s.root, style));

  // A half-diminished chord drawn `ø` is the `m` and the `♭5` said once as a glyph; a `spell` style
  // draws it as the ordinary `m7♭5` it is, so it flows through the normal path with the `♭5` shown.
  const halfDimCircle = isHalfDiminished(s) && style.halfDiminished === 'circle';

  if (halfDimCircle) {
    push('ø');
  } else {
    if (s.triad === 'minor') push(minorMarker(style));
    else if (s.triad === 'augmented') push(augmentedMarker(style));
    else if (s.triad === 'diminished') push(diminishedMarker(style));

    if (s.seventh === 'major') {
      if (style.majorSeventh === 'delta') {
        if (style.triangleScale === 1) push('Δ');
        else {
          runs.push(scaledDelta(size, style.triangleScale));
          label += 'Δ';
        }
      } else {
        push(majorSeventhWord(style.majorSeventh));
      }
    }
  }

  const alterations = shownAlterations(s, halfDimCircle);
  const lead = superscriptLead(s);

  if (style.stackAlterations && alterations.length >= 2 && s.bass === null) {
    const stacked = stackedSuperscript(lead, alterations, size, style);
    runs.push(...stacked.runs);
    label += stacked.label;
  } else {
    const rendered = alterations.map((a) => formatAlteration(a, style)).join('');
    const parenthesised =
      alterations.length === 0 ? '' : style.parenthesizeAlterations ? `(${rendered})` : rendered;
    const raised = `${lead}${parenthesised}`;
    if (raised !== '') {
      runs.push(superscript(raised, size));
      label += raised;
    }
  }

  // The slash and the bass stay at full size: a superscripted bass reads as an extension.
  if (s.bass !== null) push(`/${formatRootStyled(s.bass, style)}`);
  return { runs, label };
}

function formatRootStyled(root: Root, style: ChordStyle): string {
  return `${root.step}${styledAccidental(formatAlter(root.alter), style.rootAccidental)}`;
}

/** ASCII `b`/`#` (as `formatAlter` and the tension code produce them) → the chosen glyph form. */
function styledAccidental(ascii: string, mode: AccidentalGlyph): string {
  if (mode === 'ascii') return ascii;
  return ascii.replaceAll('b', FLAT).replaceAll('#', SHARP);
}

function minorMarker(style: ChordStyle): string {
  return style.minor === 'min' ? 'min' : style.minor === 'dash' ? '-' : 'm';
}

function augmentedMarker(style: ChordStyle): string {
  return style.augmented === 'aug' ? 'aug' : '+';
}

function diminishedMarker(style: ChordStyle): string {
  return style.diminished === 'dim' ? 'dim' : '°';
}

function majorSeventhWord(glyph: MajorSeventhGlyph): string {
  return glyph === 'maj' ? 'maj' : glyph === 'ma' ? 'ma' : 'M';
}

/** The superscript number: the extension or seventh, a sixth, the `alt` shorthand, a suspension. */
function superscriptLead(s: ChordStructure): string {
  if (s.alt) return '7alt';
  const top = s.seventh !== null ? String(s.extension ?? 7) : s.sixth ? '6' : s.power ? '5' : '';
  return s.suspension === null ? top : `${top}${s.suspension}`;
}

function shownAlterations(s: ChordStructure, halfDimCircle: boolean): Alteration[] {
  return halfDimCircle
    ? s.alterations.filter((a) => !(a.degree === 5 && a.alter === -1))
    : [...s.alterations];
}

function isHalfDiminished(s: ChordStructure): boolean {
  return (
    s.triad === 'minor' &&
    s.seventh === 'minor' &&
    s.alterations.some((a) => a.degree === 5 && a.alter === -1)
  );
}

function formatAlteration(a: Alteration, style: ChordStyle): string {
  const sign =
    a.alter < 0
      ? style.tensionAccidental === 'glyph'
        ? FLAT
        : 'b'
      : style.tensionAccidental === 'glyph'
        ? SHARP
        : '#';
  return `${sign}${a.degree}`;
}

/** A `Δ` drawn at less than full size, as its own baseline tspan (a `triangleScale` other than 1). */
function scaledDelta(size: number, scale: number): SvgElement {
  return {
    name: 'tspan',
    attrs: { 'font-size': `${round(size * scale)}px` },
    children: [],
    text: ['Δ'],
  };
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
 * up. Only reached when there is no bass, so nothing has to resume after the stack. Returns the
 * runs and the plain string they spell (lead then alterations, low line last), in reading order.
 */
function stackedSuperscript(
  lead: string,
  alterations: Alteration[],
  size: number,
  style: ChordStyle,
): { runs: SvgElement[]; label: string } {
  const scaled = size * STACK_SCALE;
  const first = alterations[0] as Alteration;
  const firstText = formatAlteration(first, style);
  const top = `${lead}${firstText}`;

  const runs: SvgElement[] = [
    {
      name: 'tspan',
      attrs: { 'font-size': `${round(scaled)}px`, dy: -round(size * SUPERSCRIPT_RISE) },
      children: [],
      text: [top],
    },
  ];
  let label = top;

  let previous = firstText;
  for (const alteration of alterations.slice(1)) {
    const text = formatAlteration(alteration, style);
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
    label += text;
    previous = text;
  }
  return { runs, label };
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
