/**
 * Per-system chord labels for the Stage-2b chord-band recogniser (V17b, ADR-0031).
 *
 * The recogniser reads one system's chord band and emits the chord symbols in it, left to right — so
 * the training unit is `(band crop, chord glyph strings)`. This module reads the label off `layout()`:
 * each system's bars carry their chord items in reading order (bar order, then onset), which is x order
 * across the band. Each chord's label is what will actually be drawn — `chordGlyphText(text, style)`,
 * the same string the engraver inks for the given `ChordStyle` — so the label matches the pixels. The
 * imaging half cuts the crop (`imaging/band-crops.ts`); this stays pure for the fast test layer.
 *
 * Framework-free, Node-free plain TypeScript. `@sibei/engrave` is pure (markup, no native binding).
 */

import type { ChordStyle } from '@sibei/engrave';
import { CANONICAL_CHORD_STYLE, chordGlyphText } from '@sibei/engrave';
import type { PageSpecInput } from '@sibei/layout';
import { layout } from '@sibei/layout';
import type { Score } from '@sibei/model';

export interface SystemChords {
  /** The system's index across the whole score (`LayoutSystem.index`). */
  index: number;
  page: number;
  /** Whether the system reserves a chord band (has at least one chord). */
  hasBand: boolean;
  /** The chord glyph strings in reading order — the label for this system's band crop. */
  chords: string[];
}

export interface ExtractSystemChordsOptions {
  pageSpec?: PageSpecInput;
  /** The symbology the crop is rendered in; the labels must match it. Defaults to canonical. */
  style?: ChordStyle;
}

/**
 * Extract the ordered chord glyph strings per staff system. Only real chord symbols are labelled;
 * a plain annotation (Q56) is not a chord and is left out (the generator emits none anyway).
 */
export function extractSystemChords(
  score: Score,
  options: ExtractSystemChordsOptions = {},
): SystemChords[] {
  const style = options.style ?? CANONICAL_CHORD_STYLE;
  const result = layout(score, options.pageSpec ?? {});
  const out: SystemChords[] = [];

  for (const page of result.pages) {
    for (const system of page.systems) {
      const chords: string[] = [];
      for (const bar of system.bars) {
        const items = bar.items
          .filter((item): item is Extract<typeof item, { kind: 'chordSymbol' }> => item.kind === 'chordSymbol')
          .sort((a, b) => a.onset - b.onset);
        for (const item of items) chords.push(chordGlyphText(item.text, style));
      }
      out.push({ index: system.index, page: page.index, hasBand: chords.length > 0, chords });
    }
  }

  return out;
}
