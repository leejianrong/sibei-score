import type { BarView, Id, KeySignature, Note, Score } from '@sibei/model';
import { beatOfOnset, tupletOf } from '@sibei/model';
import { graceAccidentals, resolveBarAccidentals } from './accidentals.js';
import type { GraceItem, LayoutBarItem } from './items.js';

/**
 * The part of a bar's items that belongs to one voice: its notes, rests and tuplet brackets. Shared by the lead-sheet
 * bar (`layout.ts`, which adds the clef, barlines, chords and marks around them) and by the staves and voices of a
 * multi-staff system (`lanes.ts`, SIB2-227), so a note is turned into a layout item in exactly one place.
 */

/** The note item's `ottava` field only when the note is under a line, so an unmarked chart's items are unchanged. */
function ottavaField(shift: 'up' | 'down' | undefined): { ottava?: 'up' | 'down' } {
  return shift === undefined ? {} : { ottava: shift };
}

export function noteAndRestItems(score: Score, bar: BarView, shifts: Map<Id, 'up' | 'down'>): LayoutBarItem[] {
  const time = score.meta.time;
  const items: LayoutBarItem[] = [];
  const accidentals = resolveBarAccidentals(bar, score.meta.key);
  const ordered = [...bar.items].sort((a, b) => a.onset - b.onset);
  for (const item of ordered) {
    const tuplet = tupletOf(item.id, bar);
    if (item.kind === 'note') {
      items.push({
        kind: 'note',
        noteId: item.id,
        onset: item.onset,
        beat: beatOfOnset(item.onset, time),
        duration: item.duration,
        pitch: item.pitch,
        ...ottavaField(shifts.get(item.id)),
        accidental: item.accidental,
        // A drum has no accidental: its pitch is only where it is written.
        accidentalGlyph: item.drum === undefined ? (accidentals.get(item.id) ?? null) : null,
        tie: item.tie,
        tupletId: tuplet === null ? null : tuplet.id,
        flagged: item.review.flagged,
        ...(item.fermata === true ? { fermata: true } : {}),
        ...(item.drum === undefined ? {} : { drum: item.drum }),
        ...(item.head === undefined ? {} : { head: item.head }),
        ...(item.articulations === undefined ? {} : { articulations: item.articulations }),
        ...(item.graces === undefined || item.graces.length === 0
          ? {}
          : { graces: graceItems(item, score.meta.key) }),
      });
    } else {
      items.push({
        kind: 'rest',
        restId: item.id,
        onset: item.onset,
        beat: beatOfOnset(item.onset, time),
        duration: item.duration,
        tupletId: tuplet === null ? null : tuplet.id,
        flagged: item.review.flagged,
        ...(item.fermata === true ? { fermata: true } : {}),
      });
    }
  }
  return items;
}

export function tupletBracketItems(bar: BarView): LayoutBarItem[] {
  return bar.tuplets.map((tuplet) => ({
    kind: 'tupletBracket',
    tupletId: tuplet.id,
    actual: tuplet.actual,
    normal: tuplet.normal,
    memberIds: tuplet.memberIds,
  }));
}

function graceItems(note: Note, key: KeySignature): GraceItem[] {
  const glyphs = graceAccidentals(note, key);
  return (note.graces ?? []).map((grace, index) => ({
    graceId: grace.id,
    pitch: grace.pitch,
    value: grace.value,
    slashed: grace.slashed,
    accidental: grace.accidental,
    accidentalGlyph: glyphs[index] ?? null,
  }));
}
