import type { Id, Score } from '@sibei/model';
import { MAX_VERSES, allStaves, barViews, orderedItems, voiceSelects } from '@sibei/model';
import type { LayoutLyricLink } from './items.js';

/**
 * Lyric hyphens and extender lines (SIB2-273, ADR-0021 amendment). A syllable's text is drawn by the engraver from the
 * note item; what needs the *score* is the link between one syllable and the next, since a word and a melisma run
 * across bars and across system breaks. This plans those links per system, the way `planOttavas` plans a line.
 *
 * A hyphen is drawn between a `begin` or `middle` syllable and the next syllable of its verse on the same staff and
 * voice. When that syllable is on another system, or there is none, the hyphen trails after its own text instead.
 * An `extend` line runs from the syllable through the notes after it, up to the verse's next syllable; across a system
 * break it is two halves.
 */
export function planLyricLinks(
  score: Score,
  systemOfNote: ReadonlyMap<Id, number>,
  staffOfNote?: ReadonlyMap<Id, number>,
): Map<number, LayoutLyricLink[]> {
  const bySystem = new Map<number, LayoutLyricLink[]>();
  const push = (system: number, link: LayoutLyricLink): void => {
    const list = bySystem.get(system);
    if (list === undefined) bySystem.set(system, [link]);
    else list.push(link);
  };
  const staffIds = allStaves(score).map((staff) => staff.id);

  for (const which of voiceSelects(score)) {
    const notes = barViews(score, which).flatMap((bar) => orderedItems(bar).filter((item) => item.kind === 'note'));
    if (!notes.some((note) => note.kind === 'note' && note.lyrics !== undefined)) continue;
    const staffIndex = staffIds.indexOf(which.staff);
    for (let verse = 1; verse <= MAX_VERSES; verse += 1) {
      const chain: number[] = [];
      notes.forEach((note, at) => {
        if (note.kind === 'note' && note.lyrics?.some((lyric) => lyric.verse === verse)) chain.push(at);
      });
      chain.forEach((at, position) => {
        const note = notes[at];
        if (note === undefined || note.kind !== 'note') return;
        const lyric = note.lyrics?.find((candidate) => candidate.verse === verse);
        const system = systemOfNote.get(note.id);
        if (lyric === undefined || system === undefined) return;
        const staff = staffOfNote?.get(note.id) ?? Math.max(staffIndex, 0);
        const own = staff > 0 ? { staff } : {};
        const nextAt = chain[position + 1];
        const next = nextAt === undefined ? undefined : notes[nextAt];

        if (lyric.syllabic === 'begin' || lyric.syllabic === 'middle') {
          const sameSystem = next !== undefined && systemOfNote.get(next.id) === system;
          push(system, { verse, kind: 'hyphen', fromNoteId: note.id, toNoteId: sameSystem && next !== undefined ? next.id : null, ...own });
        }
        if (lyric.extend === true) {
          // On through the notes that carry no syllable of this verse, to the one before the next that does.
          const endAt = nextAt === undefined ? notes.length - 1 : Math.max(at, nextAt - 1);
          const end = notes[endAt] ?? note;
          const last = systemOfNote.get(end.id) ?? system;
          for (let current = system; current <= last; current += 1) {
            push(current, {
              verse,
              kind: 'extend',
              fromNoteId: current === system ? note.id : null,
              toNoteId: current === last ? end.id : null,
              ...own,
            });
          }
        }
      });
    }
  }
  return bySystem;
}
