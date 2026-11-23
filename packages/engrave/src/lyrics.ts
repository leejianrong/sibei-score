import { LYRIC_PITCH, LYRIC_SIZE } from '@sibei/layout';
import type { LayoutLyricLink } from '@sibei/layout';
import type { Lyric } from '@sibei/model';
import type { SvgElement } from './svg.js';
import { el } from './svg.js';
import { text } from './text.js';

/**
 * Lyrics under a staff (SIB2-273, ADR-0021 amendment). Layout reserved a row per verse and handed the engraver the first
 * baseline; each syllable is centred under its notehead with `text-anchor`, never measured (ADR-0015), so where a
 * hyphen or an extender starts after a syllable it is estimated from the character count, as the ottava label is.
 */

/** A note that carries lyrics: where its head is, so the syllable centres under it. */
export interface LyricMark {
  x: number;
  width: number;
  lyrics: readonly Lyric[];
}

/** Half the width of a syllable's text, estimated: the face is a serif of about half an em per character. */
function halfText(value: string): number {
  return (value.length * LYRIC_SIZE * 0.5) / 2;
}

const baselineOf = (first: number, verse: number): number => first + (verse - 1) * LYRIC_PITCH;

export function lyricInk(
  marks: ReadonlyMap<string, LyricMark>,
  links: readonly LayoutLyricLink[],
  firstBaseline: number,
  musicLeft: number,
  systemRight: number,
  family: string,
): SvgElement[] {
  const out: SvgElement[] = [];
  for (const [, mark] of marks) {
    for (const lyric of mark.lyrics) {
      out.push(
        text({
          text: lyric.text,
          x: mark.x + mark.width / 2,
          y: baselineOf(firstBaseline, lyric.verse),
          size: LYRIC_SIZE,
          align: 'center',
          family,
          class: 'se-lyric',
        }),
      );
    }
  }
  for (const link of links) {
    const from = link.fromNoteId === null ? undefined : marks.get(link.fromNoteId);
    const to = link.toNoteId === null ? undefined : marks.get(link.toNoteId);
    const lyric = from?.lyrics.find((candidate) => candidate.verse === link.verse);
    const y = baselineOf(firstBaseline, link.verse);
    const fromCentre = from === undefined ? undefined : from.x + from.width / 2;
    if (link.kind === 'hyphen') {
      if (from === undefined || fromCentre === undefined || lyric === undefined) continue;
      // Between the two syllables' centres; trailing after its own text when the next is not on this system.
      const x = to === undefined ? fromCentre + halfText(lyric.text) + LYRIC_SIZE * 0.45 : (fromCentre + (to.x + to.width / 2)) / 2;
      out.push(text({ text: '-', x, y, size: LYRIC_SIZE, align: 'center', family, class: 'se-lyric-hyphen' }));
      continue;
    }
    // An extender: from after the syllable (or the system's left) to the right edge of its last note (or the edge).
    const start = fromCentre === undefined || lyric === undefined ? musicLeft : fromCentre + halfText(lyric.text) + LYRIC_SIZE * 0.3;
    const end = link.toNoteId === null ? systemRight : to === undefined ? start : to.x + to.width;
    if (end - start < 4) continue;
    out.push(
      el('path', {
        class: 'se-lyric-extend',
        d: `M${start} ${y + 1}L${end} ${y + 1}`,
        fill: 'none',
        stroke: '#000000',
        'stroke-width': 0.8,
      }),
    );
  }
  return out;
}
