import { DEFAULT_MUSIC_FONT } from '@sibei/engrave';
import type { Score } from '@sibei/model';
import { loadFont, pageChordBoxes, pageItemBoxes, renderScorePages } from '@sibei/ui';

/**
 * Where to click to select a note, computed from the **same** geometry the browser hit-tests
 * against (`@sibei/ui`'s `renderScorePages` + `pageItemBoxes`) — not a guessed pixel.
 *
 * The click handler maps a pixel to layout units as `(clientX - rect.left) / rect.width *
 * page.layout.width` (`SheetStack.svelte`), so a fraction of the sheet's box maps straight back to
 * a layout position. We render the score with the score view's own defaults — A4, the default face
 * — because that is what the page shows on load, and take the centre of the note's box as the
 * fraction to click. Reusing the app's functions is the point: the test cannot disagree with the
 * ink for the same reason the inspector cannot.
 */

export interface NoteTarget {
  noteId: string;
  pageIndex: number;
  /** Fraction of the sheet's width/height — multiply by the rendered sheet box to get a pixel. */
  cx: number;
  cy: number;
}

export function firstNoteTarget(score: Score): NoteTarget {
  const pages = renderScorePages(score, { paper: 'a4' }, { font: DEFAULT_MUSIC_FONT });
  const font = loadFont(DEFAULT_MUSIC_FONT);
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    if (page === undefined) continue;
    const note = pageItemBoxes(page.layout, font).find((box) => box.kind === 'note');
    if (note !== undefined) {
      return {
        noteId: note.id,
        pageIndex,
        cx: (note.x + note.width / 2) / page.layout.width,
        cy: (note.y + note.height / 2) / page.layout.height,
      };
    }
  }
  throw new Error('the score has no note to target');
}

/**
 * Where to click in the **chord band** above a bar to add a chord at a beat (V5e) — the same layout
 * the app hit-tests against, so the test cannot disagree with the app about where the band is. The
 * band's baseline is `staveY - chordBaselineOffset` and its beats are spaced across the bar's music
 * area, exactly as `chord-hit.ts` computes them; a point just above the baseline lands squarely in
 * the band and clear of the notes below.
 */
export function chordBandTarget(score: Score, barNumber: number, beat: number): NoteTarget {
  const pages = renderScorePages(score, { paper: 'a4' }, { font: DEFAULT_MUSIC_FONT });
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    if (page === undefined) continue;
    for (const system of page.layout.systems) {
      const bar = system.bars.find((candidate) => candidate.barNumber === barNumber);
      if (bar === undefined) continue;
      const left = bar.x + bar.prefixWidth;
      const right = bar.x + bar.width;
      const fraction = score.meta.time.beats <= 1 ? 0 : (beat - 1) / (score.meta.time.beats - 1);
      const x = left + fraction * (right - left);
      // Comfortably inside the band: a bar with no chords yet reserves none (chordBaselineOffset is
      // 0), so the band is only a glyph-height tall just above the staff — aim clear of both edges.
      const y = system.staveY - system.chordBaselineOffset - 10;
      return { noteId: `bar${barNumber}.beat${beat}`, pageIndex, cx: x / page.layout.width, cy: y / page.layout.height };
    }
  }
  throw new Error(`no bar ${barNumber} to target`);
}

/** The centre of the first engraved chord, for clicking it to edit — the chord analogue of `firstNoteTarget`. */
export function firstChordTarget(score: Score): NoteTarget {
  const pages = renderScorePages(score, { paper: 'a4' }, { font: DEFAULT_MUSIC_FONT });
  const font = loadFont(DEFAULT_MUSIC_FONT);
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    if (page === undefined) continue;
    const chord = pageChordBoxes(page.layout, font)[0];
    if (chord !== undefined) {
      return {
        noteId: chord.chordId,
        pageIndex,
        cx: (chord.x + chord.width / 2) / page.layout.width,
        cy: (chord.y + chord.height / 2) / page.layout.height,
      };
    }
  }
  throw new Error('the score has no chord to target');
}
