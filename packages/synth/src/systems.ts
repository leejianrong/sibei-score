/**
 * Per-system training labels for the Stage-2a staff recogniser (V15a, ADR-0031).
 *
 * A CRNN+CTC reads one staff system at a time and emits its note/rest sequence, so the training unit
 * is `(system crop, token sequence)` — not the whole page. This module reads both off `layout()`:
 * each `LayoutSystem` already carries its bounding box (in layout units) and its bars in reading
 * order, so the crop box and the ordered tokens fall straight out, with no detection and no second
 * pass over the score. Cutting the pixels from a rendered page is the imaging half
 * (`@sibei/synth/imaging`); this stays pure so it runs on the fast test layer.
 *
 * The box is in **layout units**. The imaging step turns it into pixels with a single scale,
 * `pxPerUnit = renderedPngWidth / page.width`, which needs no dpi assumption because the engraved
 * SVG's viewBox is in those same units (`packages/engrave`).
 *
 * Framework-free, Node-free plain TypeScript.
 */

import type { NoteItem, PageSpecInput, RestItem } from '@sibei/layout';
import { layout } from '@sibei/layout';
import type { Score } from '@sibei/model';
import type { ItemToken } from './labels.js';
import type { Vocabulary } from './vocab.js';

/** A system's bounding box, in layout units. Multiply by `pxPerUnit` for the pixel crop. */
export interface SystemCropBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SystemLabel {
  /** The system's index across the whole score (`LayoutSystem.index`). */
  index: number;
  box: SystemCropBox;
  /** Notes and rests in reading order — the CTC target sequence. */
  tokens: ItemToken[];
  /** The vocabulary class ids for `tokens`, present only when a vocabulary was supplied. */
  tokenIds?: number[];
}

export interface ExtractSystemLabelsOptions {
  pageSpec?: PageSpecInput;
  /** When given, each system also carries `tokenIds` from this vocabulary (V15a). */
  vocab?: Vocabulary;
}

function toToken(item: NoteItem | RestItem): ItemToken {
  return item.kind === 'note'
    ? {
        kind: 'note',
        step: item.pitch.step,
        alter: item.pitch.alter,
        octave: item.pitch.octave,
        value: item.duration.value,
        dots: item.duration.dots,
      }
    : { kind: 'rest', value: item.duration.value, dots: item.duration.dots };
}

/**
 * Extract one `SystemLabel` per staff system, pages then systems in order. The tokens are the flat
 * note/rest sequence a CRNN+CTC learns; concatenated across systems they equal the score's own
 * `itemSequence` (asserted in the tests), so the crop-level labels and the page-level ground truth
 * are the same data seen at two granularities.
 */
export function extractSystemLabels(
  score: Score,
  options: ExtractSystemLabelsOptions = {},
): SystemLabel[] {
  const result = layout(score, options.pageSpec ?? {});
  const labels: SystemLabel[] = [];

  for (const page of result.pages) {
    for (const system of page.systems) {
      const tokens: ItemToken[] = [];
      for (const bar of system.bars) {
        const items = bar.items
          .filter((item): item is NoteItem | RestItem => item.kind === 'note' || item.kind === 'rest')
          .sort((a, b) => a.onset - b.onset);
        for (const item of items) tokens.push(toToken(item));
      }

      const vocab = options.vocab;
      labels.push({
        index: system.index,
        box: { page: page.index, x: system.x, y: system.y, width: system.width, height: system.height },
        tokens,
        ...(vocab ? { tokenIds: tokens.map((token) => vocab.idOf(token)) } : {}),
      });
    }
  }

  return labels;
}
