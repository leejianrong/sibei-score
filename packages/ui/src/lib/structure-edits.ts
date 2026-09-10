import type { EndBarline, EndingRole, StartBarline } from '@sibei/model';
import type { Operation } from './api.js';

/**
 * The Structure panel's diff (V7c) — the one risky piece of that card, so it lives here as a pure
 * function the component calls and a unit test can pin, rather than inside a Svelte component where
 * only a browser could reach it.
 *
 * A bar's structure is four independent things — the section, the two barlines, the ending. Save
 * turns the difference between what the bar carries and what the panel now shows into the minimal
 * batch of the ops V7a/V7b built, so undo reverts the whole structural edit as one unit and a save
 * that changed nothing posts nothing (the server refuses an empty batch).
 */

/** The structure a bar carries now — read fresh from the model, the seed for the panel. */
export interface BarStructure {
  barNumber: number;
  /** The whole-bar address the ops target: `bar7`. */
  addr: string;
  /** The pickup (bar 0) is not a grid bar; a section on it would never break a line. */
  isPickup: boolean;
  /** Whether a section begins on this bar at all — a bare boundary reads as empty letter+name. */
  hasSection: boolean;
  letter: string;
  name: string;
  startBarline: StartBarline;
  endBarline: EndBarline;
  ending: { numbers: number[]; role: EndingRole } | null;
}

/** What Save asks for. Empty letter *and* name means "no section here". */
export interface StructureEdits {
  letter: string;
  name: string;
  startBarline: StartBarline;
  endBarline: EndBarline;
  ending: { numbers: number[]; role: EndingRole } | null;
}

function endingsEqual(a: StructureEdits['ending'], b: StructureEdits['ending']): boolean {
  if (a === null || b === null) return a === b;
  return a.role === b.role && a.numbers.length === b.numbers.length && a.numbers.every((n, i) => n === b.numbers[i]);
}

/** The minimal ops to move a bar from `cur` to `edits` — empty when nothing changed. */
export function structureOps(cur: BarStructure, edits: StructureEdits): Operation[] {
  const target = cur.addr;
  const operations: Operation[] = [];

  const wantsSection = edits.letter !== '' || edits.name !== '';
  if (wantsSection) {
    if (!cur.hasSection || cur.letter !== edits.letter || cur.name !== edits.name) {
      operations.push({
        type: 'section.set',
        target,
        payload: { letter: edits.letter === '' ? null : edits.letter, name: edits.name === '' ? null : edits.name },
      });
    }
  } else if (cur.hasSection) {
    operations.push({ type: 'section.rm', target });
  }

  if (edits.startBarline !== cur.startBarline || edits.endBarline !== cur.endBarline) {
    const payload: { start?: StartBarline; end?: EndBarline } = {};
    if (edits.startBarline !== cur.startBarline) payload.start = edits.startBarline;
    if (edits.endBarline !== cur.endBarline) payload.end = edits.endBarline;
    operations.push({ type: 'barline.set', target, payload });
  }

  if (!endingsEqual(edits.ending, cur.ending)) {
    if (edits.ending === null) operations.push({ type: 'ending.rm', target });
    else operations.push({ type: 'ending.set', target, payload: edits.ending });
  }

  return operations;
}
