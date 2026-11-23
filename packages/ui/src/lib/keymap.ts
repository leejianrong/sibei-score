import type { KeyLike } from './note-input.js';

/**
 * The score view's keyboard map, in one place (SIB2-268).
 *
 * Two readers share this file and so cannot drift apart: `ScoreView.svelte` asks `chartActionFor` which action a key
 * means (and switches on it), and the `?` overlay (`ShortcutsOverlay.svelte`) prints `SHORTCUT_GROUPS`, which is built
 * from the same `BINDINGS`. A key that does something has a row here or it does nothing at all. The note-input keys keep
 * their own matcher (`actionForKey` in `note-input.ts`); their overlay rows are `INPUT_ROWS`, and `tests/unit/ui-keymap`
 * runs a sample of each through that matcher so a row cannot describe a key the mode ignores.
 *
 * Not here, because they are not key events: clicks, and copy/cut/paste, which arrive as clipboard events (`CLIPBOARD_ROWS`).
 */

export type ChartAction =
  | 'undo'
  | 'redo'
  | 'help'
  | 'select-all'
  | 'deselect'
  | 'delete'
  | 'next'
  | 'prev'
  | 'next-bar'
  | 'prev-bar'
  | 'up'
  | 'down'
  | 'voice'
  | 'note-input';

export interface Binding {
  action: ChartAction;
  /** What the overlay prints in the key cap. */
  keys: string;
  does: string;
  /** Whether the key still means this while note input is open (the mode claims the rest). */
  inNoteInput: boolean;
  match: (event: KeyLike) => boolean;
  /** Events that must resolve to this action; the unit test runs them. */
  samples: KeyLike[];
}

function key(name: string, mods: Partial<Pick<KeyLike, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>> = {}): KeyLike {
  return { key: name, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

const plain = (event: KeyLike): boolean => !event.ctrlKey && !event.metaKey && !event.altKey;
const bare = (event: KeyLike): boolean => plain(event) && !event.shiftKey;
const mod = (event: KeyLike): boolean => (event.ctrlKey || event.metaKey) && !event.altKey;

export const BINDINGS: readonly Binding[] = [
  { action: 'undo', keys: 'Ctrl/⌘ Z', does: 'Undo', inNoteInput: true, match: (e) => mod(e) && !e.shiftKey && e.key.toLowerCase() === 'z', samples: [key('z', { ctrlKey: true }), key('z', { metaKey: true })] },
  {
    action: 'redo',
    keys: 'Ctrl/⌘ Shift Z, Ctrl Y',
    does: 'Redo',
    inNoteInput: true,
    match: (e) => mod(e) && ((e.shiftKey && e.key.toLowerCase() === 'z') || (!e.shiftKey && e.key.toLowerCase() === 'y')),
    samples: [key('Z', { ctrlKey: true, shiftKey: true }), key('y', { ctrlKey: true })],
  },
  { action: 'help', keys: '?', does: 'This list', inNoteInput: true, match: (e) => e.key === '?' && plain(e), samples: [key('?', { shiftKey: true })] },
  { action: 'note-input', keys: 'N', does: 'Start note input (at the selected note or bar)', inNoteInput: false, match: (e) => e.key.toLowerCase() === 'n' && plain(e), samples: [key('n'), key('N', { shiftKey: true })] },
  { action: 'select-all', keys: 'Ctrl/⌘ A', does: 'Pick every note and rest of the active staff', inNoteInput: false, match: (e) => mod(e) && e.key.toLowerCase() === 'a', samples: [key('a', { ctrlKey: true }), key('a', { metaKey: true })] },
  { action: 'next', keys: '→', does: 'Move the selection to the next note or rest in the voice (with none selected: the first)', inNoteInput: false, match: (e) => bare(e) && e.key === 'ArrowRight', samples: [key('ArrowRight')] },
  { action: 'prev', keys: '←', does: 'Move the selection to the previous note or rest in the voice (with none selected: the last)', inNoteInput: false, match: (e) => bare(e) && e.key === 'ArrowLeft', samples: [key('ArrowLeft')] },
  { action: 'next-bar', keys: 'Ctrl/⌘ →', does: 'Jump to the first note of the next bar', inNoteInput: false, match: (e) => mod(e) && !e.shiftKey && e.key === 'ArrowRight', samples: [key('ArrowRight', { ctrlKey: true }), key('ArrowRight', { metaKey: true })] },
  { action: 'prev-bar', keys: 'Ctrl/⌘ ←', does: 'Jump to the first note of the previous bar', inNoteInput: false, match: (e) => mod(e) && !e.shiftKey && e.key === 'ArrowLeft', samples: [key('ArrowLeft', { ctrlKey: true }), key('ArrowLeft', { metaKey: true })] },
  { action: 'up', keys: '↑', does: 'Move the selection to the staff above, at the same place in the bar', inNoteInput: false, match: (e) => bare(e) && e.key === 'ArrowUp', samples: [key('ArrowUp')] },
  { action: 'down', keys: '↓', does: 'Move the selection to the staff below, at the same place in the bar', inNoteInput: false, match: (e) => bare(e) && e.key === 'ArrowDown', samples: [key('ArrowDown')] },
  { action: 'delete', keys: 'Delete, Backspace', does: 'Delete the selected note, rest or chord, or every selected note', inNoteInput: false, match: (e) => bare(e) && (e.key === 'Delete' || e.key === 'Backspace'), samples: [key('Delete'), key('Backspace')] },
  { action: 'deselect', keys: 'Esc', does: 'Clear the selection', inNoteInput: false, match: (e) => bare(e) && e.key === 'Escape', samples: [key('Escape')] },
  { action: 'voice', keys: '1 to 4', does: 'Choose that voice of the active staff (charts with more than one lane)', inNoteInput: false, match: (e) => bare(e) && /^[1-4]$/.test(e.key), samples: [key('1'), key('4')] },
];

/** The action a key event means in the score view, or null. While note input is open only the bindings flagged for it count. */
export function chartActionFor(event: KeyLike, noteInput: boolean): ChartAction | null {
  for (const binding of BINDINGS) {
    if (noteInput && !binding.inNoteInput) continue;
    if (binding.match(event)) return binding.action;
  }
  return null;
}

export interface ShortcutGroup {
  title: string;
  note?: string;
  rows: ReadonlyArray<[string, string]>;
}

const rowOf = (action: ChartAction): [string, string] => {
  const binding = BINDINGS.find((candidate) => candidate.action === action)!;
  return [binding.keys, binding.does];
};

/** Clicks and the clipboard: real controls of the score view that are not key events, so they have no matcher. */
export const CLIPBOARD_ROWS: ReadonlyArray<[string, string]> = [
  ['Click, Shift-click, Ctrl/⌘-click', 'Pick a note, a range of notes, or add one; Shift-click a second bar for a bar range'],
  ['Ctrl/⌘ C, X, V', 'Copy, cut, paste at the selected note or bar (replaces the span it covers)'],
];

/** The note-input rows. Each carries samples for the test that runs them through `actionForKey`. */
export const INPUT_ROWS: ReadonlyArray<{ keys: string; does: string; samples: KeyLike[] }> = [
  { keys: '1 2 3 4 5 6', does: '32nd, 16th, eighth, quarter, half, whole', samples: [key('1'), key('6')] },
  { keys: '.', does: 'Dot the next note', samples: [key('.')] },
  { keys: 'A to G', does: 'Enter that pitch, in the octave nearest the last note, in the key signature', samples: [key('a'), key('g')] },
  { keys: 'Shift + A to G', does: 'Add that pitch above the last note, making a chord', samples: [key('A', { shiftKey: true })] },
  { keys: 'R', does: 'Rest', samples: [key('r')] },
  { keys: '↑ ↓', does: 'Move the last note a step; with Ctrl/⌘, an octave', samples: [key('ArrowUp'), key('ArrowDown', { ctrlKey: true })] },
  { keys: '+ or #  /  -  /  0', does: 'Sharpen, flatten or naturalise the last note (with no note before the caret: the next one)', samples: [key('+'), key('-'), key('0')] },
  { keys: 'T', does: 'Tie the last note to the next', samples: [key('t')] },
  { keys: 'Enter, Space', does: 'Skip forward over a value; at the end of the chart, add a bar', samples: [key('Enter'), key(' ')] },
  { keys: 'Backspace', does: 'Delete the previous note and step back', samples: [key('Backspace')] },
  { keys: '← →', does: 'Move the caret', samples: [key('ArrowLeft'), key('ArrowRight')] },
  { keys: 'Ctrl+Alt+1 to 4', does: 'Switch voice', samples: [{ ...key('1', { ctrlKey: true, altKey: true }), code: 'Digit1' }] },
  { keys: 'Esc', does: 'Leave note input', samples: [key('Escape')] },
];

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: 'Anywhere in a chart',
    rows: [rowOf('undo'), rowOf('redo'), rowOf('note-input'), rowOf('voice'), rowOf('help')],
  },
  {
    title: 'Selecting and editing',
    note: 'Click the sheet or press Tab to focus it, then use the arrow keys. A selected note or rest has its own controls in the rail.',
    rows: [...CLIPBOARD_ROWS.slice(0, 1), rowOf('next'), rowOf('prev'), rowOf('next-bar'), rowOf('prev-bar'), rowOf('up'), rowOf('down'), rowOf('select-all'), rowOf('delete'), rowOf('deselect'), ...CLIPBOARD_ROWS.slice(1)],
  },
  {
    title: 'Note input',
    note: 'Inside note input the digits are note values, not voices. Ctrl+Alt+1 to 4 picks the voice instead.',
    rows: INPUT_ROWS.map((row): [string, string] => [row.keys, row.does]),
  },
];
