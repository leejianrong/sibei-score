import { DEFAULT_MUSIC_FONT } from '@sibei/engrave';
import type { Score } from '@sibei/model';
import { barBoxFor, loadFont, pageBarBoxes, pageChordBoxes, pageItemBoxes, renderScorePages } from '@sibei/ui';

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

/** Where to click one head of a stacked chord (SIB2-252): the box of the pitch written `pitch` (`E4`). */
export function toneTarget(score: Score, pitch: string): NoteTarget {
  const pages = renderScorePages(score, { paper: 'a4' }, { font: DEFAULT_MUSIC_FONT });
  const font = loadFont(DEFAULT_MUSIC_FONT);
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    if (page === undefined) continue;
    const head = pageItemBoxes(page.layout, font).find((box) => box.kind === 'note' && box.pitch === pitch);
    if (head !== undefined) {
      return {
        noteId: head.toneId ?? head.id,
        pageIndex,
        cx: (head.x + head.width / 2) / page.layout.width,
        cy: (head.y + head.height / 2) / page.layout.height,
      };
    }
  }
  throw new Error(`the score has no head written ${pitch}`);
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

/**
 * Where to click to select a **whole bar** and open the Structure panel (V7c) — the same bar
 * geometry the browser hit-tests against (`pageBarBoxes`). Aimed low and left of centre, clear of
 * the notes and the chord band, so the click lands on the bar rather than something in it — exactly
 * where the screenshots script clicks.
 */
export function barTarget(score: Score, barNumber: number): NoteTarget {
  const pages = renderScorePages(score, { paper: 'a4' }, { font: DEFAULT_MUSIC_FONT });
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    if (page === undefined) continue;
    const box = barBoxFor(pageBarBoxes(page.layout), barNumber);
    if (box !== null) {
      return {
        noteId: `bar${barNumber}`,
        pageIndex,
        cx: (box.x + box.width * 0.3) / page.layout.width,
        cy: (box.y + box.height * 0.82) / page.layout.height,
      };
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

/**
 * Where to click the first note of one lane (ADR-0041): a staff by its index in the system (0 is the top) and a voice.
 * The same boxes the browser hit-tests against, so the click lands on that staff's ink and not the top staff's.
 */
export function laneNoteTarget(score: Score, staffIndex: number, voice = 1, kind: 'note' | 'rest' = 'note'): NoteTarget {
  const pages = renderScorePages(score, { paper: 'a4' }, { font: DEFAULT_MUSIC_FONT });
  const font = loadFont(DEFAULT_MUSIC_FONT);
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    if (page === undefined) continue;
    const note = pageItemBoxes(page.layout, font).find(
      (box) => box.kind === kind && box.staffIndex === staffIndex && box.voice === voice,
    );
    if (note !== undefined) {
      return {
        noteId: note.id,
        pageIndex,
        cx: (note.x + note.width / 2) / page.layout.width,
        cy: (note.y + note.height / 2) / page.layout.height,
      };
    }
  }
  throw new Error(`staff ${staffIndex + 1} voice ${voice} has no ${kind} to target`);
}

/** Where to click one staff's empty bar (the staff band of bar `barNumber` in staff `staffIndex`), to select it. */
export function staffBarTarget(score: Score, barNumber: number, staffIndex: number): NoteTarget {
  const pages = renderScorePages(score, { paper: 'a4' }, { font: DEFAULT_MUSIC_FONT });
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    if (page === undefined) continue;
    const box = barBoxFor(pageBarBoxes(page.layout), barNumber, staffIndex);
    if (box !== null) {
      return {
        noteId: `bar${barNumber}`,
        pageIndex,
        cx: (box.x + box.width * 0.3) / page.layout.width,
        cy: (box.y + box.height * 0.82) / page.layout.height,
      };
    }
  }
  throw new Error(`no bar ${barNumber} in staff ${staffIndex + 1} to target`);
}
