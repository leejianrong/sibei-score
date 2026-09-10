import { DEFAULT_MUSIC_FONT } from '@sibei/engrave';
import type { Score } from '@sibei/model';
import { loadFont, pageItemBoxes, renderScorePages } from '@sibei/ui';

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
