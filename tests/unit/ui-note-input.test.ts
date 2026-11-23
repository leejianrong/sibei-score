import { describe, expect, it } from 'vitest';
import { applyOperation } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { barViews, formatPitch } from '@sibei/model';
import type { Score } from '@sibei/model';
import { actionForKey, ghostScore, GHOST_ID, inputContext, nearestPitch, splitTicks, startInput, stepInput } from '../../packages/ui/src/lib/note-input.js';
import type { InputAction, InputState, KeyLike } from '../../packages/ui/src/lib/note-input.js';

/**
 * Keyboard note input (SIB2-155): the pure key map and caret machine, driven against the real op applier so every op a
 * step emits is one the server accepts, and a typed melody lands as the notes it should.
 */

const key = (k: string, extra: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });
const act = (k: string, extra: Partial<KeyLike> = {}): InputAction => {
  const action = actionForKey(key(k, extra));
  if (action === null) throw new Error(`no action for ${k}`);
  return action;
};

interface Session {
  score: Score;
  state: InputState;
  log: Operation[][];
  messages: (string | null)[];
}

function open(options: { barCount?: number; key?: { tonic: 'C' | 'G'; alter: 0; mode: 'major' } } = {}): Session {
  const created = applyOperation(null, {
    type: 'score.create',
    payload: { id: 'ni', barCount: options.barCount ?? 4, ...(options.key === undefined ? {} : { key: options.key }) },
  } as Operation);
  const score = created.score;
  return { score, state: startInput(inputContext(score), { staff: 1, voice: 1 }), log: [], messages: [] };
}

/** Type keys: each step reads the score as it stands, then its ops are applied (what the browser does between re-reads). */
function type(session: Session, ...keys: string[]): void {
  for (const k of keys) {
    const shift = k.length === 1 && /[A-G]/.test(k);
    const action = act(k, shift ? { shiftKey: true } : {});
    const result = stepInput(session.state, action, inputContext(session.score));
    let score = session.score;
    for (const op of result.ops) score = applyOperation(score, op).score;
    session.score = score;
    session.state = result.state;
    session.log.push(result.ops);
    session.messages.push(result.message);
  }
}

function viewOf(score: Score, bar: number) {
  return barViews(score).find((view) => view.number === bar)!;
}

function notes(score: Score, bar: number): string[] {
  return barViews(score)
    .find((view) => view.number === bar)!
    .items.map((item) => (item.kind === 'note' ? `${formatPitch(item.pitch)}/${item.duration.value}${'.'.repeat(item.duration.dots)}` : `r/${item.duration.value}`));
}

describe('the key map', () => {
  it('maps digits to durations in Sibelius keypad order, letters to pitches, shift+letter to a chord add', () => {
    expect(act('4')).toEqual({ type: 'duration', value: 4 });
    expect(act('1')).toEqual({ type: 'duration', value: 32 });
    expect(act('6')).toEqual({ type: 'duration', value: 1 });
    expect(act('c')).toEqual({ type: 'pitch', step: 'C', add: false });
    expect(act('G', { shiftKey: true })).toEqual({ type: 'pitch', step: 'G', add: true });
    expect(act('r')).toEqual({ type: 'rest' });
    expect(act('.')).toEqual({ type: 'dot' });
    expect(act('#')).toEqual({ type: 'accidental', delta: 1 });
    expect(act('-')).toEqual({ type: 'accidental', delta: -1 });
    expect(act('ArrowUp', { ctrlKey: true })).toEqual({ type: 'shift', steps: 7 });
    expect(act('ArrowDown')).toEqual({ type: 'shift', steps: -1 });
    expect(actionForKey({ ...key('2'), ctrlKey: true, altKey: true, code: 'Digit2' })).toEqual({ type: 'voice', voice: 2 });
  });

  it('leaves the browser shortcuts alone', () => {
    expect(actionForKey(key('z', { ctrlKey: true }))).toBeNull();
    expect(actionForKey(key('s', { metaKey: true }))).toBeNull();
    expect(actionForKey(key('h'))).toBeNull();
  });
});

describe('pitch entry', () => {
  it('places a letter at the octave nearest the last pitch, or the nearest above for a chord add', () => {
    const b4 = { step: 'B', alter: 0, octave: 4 } as const;
    expect(formatPitch(nearestPitch('C', b4, 0))).toBe('C5');
    expect(formatPitch(nearestPitch('A', b4, 0))).toBe('A4');
    expect(formatPitch(nearestPitch('E', b4, 0))).toBe('E5');
    expect(formatPitch(nearestPitch('B', b4, 0, true))).toBe('B5');
    expect(formatPitch(nearestPitch('D', b4, 0, true))).toBe('D5');
  });

  it('splits a span into the fewest legal durations', () => {
    expect(splitTicks(1920)).toEqual([{ value: 1, dots: 0 }]);
    expect(splitTicks(1440)).toEqual([{ value: 2, dots: 1 }]);
    expect(splitTicks(480 + 240 + 60)).toEqual([
      { value: 4, dots: 1 },
      { value: 32, dots: 0 },
    ]);
  });
});

describe('entering a melody without the mouse', () => {
  it('types quarter notes across bars, each nearest the last', () => {
    const s = open();
    type(s, '4', 'c', 'd', 'e', 'f', 'g', 'a', 'b', 'c');
    expect(notes(s.score, 1)).toEqual(['C5/4', 'D5/4', 'E5/4', 'F5/4']);
    expect(notes(s.score, 2)).toEqual(['G5/4', 'A5/4', 'B5/4', 'C6/4']);
    expect(s.state.caret).toEqual({ lane: { staff: 1, voice: 1 }, bar: 3, onset: 0 });
  });

  it('takes the key signature into account and an accidental on the previous note', () => {
    const s = open({ key: { tonic: 'G', alter: 0, mode: 'major' } });
    type(s, '4', 'f'); // F# in G major
    expect(notes(s.score, 1)).toEqual(['F#4/4']);
    type(s, '-');
    expect(notes(s.score, 1)).toEqual(['F4/4']);
    type(s, '#', '#');
    expect(notes(s.score, 1)).toEqual(['F##4/4']);
  });

  it('moves the previous note by step and by octave, and stacks a chord with shift+letter without advancing', () => {
    const s = open();
    type(s, '4', 'c');
    type(s, 'ArrowUp');
    expect(notes(s.score, 1)).toEqual(['D5/4']);
    type(s, 'ArrowDown', 'ArrowDown');
    expect(notes(s.score, 1)).toEqual(['B4/4']);
    type(s, 'G'); // add G above B4
    const bar = viewOf(s.score, 1);
    expect(bar.items).toHaveLength(1);
    const head = bar.items[0]!;
    expect(head.kind === 'note' && head.stack?.map((tone) => formatPitch(tone.pitch))).toEqual(['G5']);
    expect(s.state.caret.onset).toBe(480);
  });

  it('enters rests and dotted values', () => {
    const s = open();
    type(s, '2', 'r', '4', '.', 'c');
    expect(notes(s.score, 1)).toEqual(['r/16', 'C5/4.']);
  });

  it('ties a note across the barline when it does not fit', () => {
    const t = open();
    type(t, '4', 'c', 'c', 'c', '5', '.', 'c'); // a dotted half from beat 4 spills into bar 2
    expect(notes(t.score, 1)).toEqual(['C5/4', 'C5/4', 'C5/4', 'C5/4']);
    const spilled = viewOf(t.score, 2).items;
    expect(spilled.length).toBe(1);
    const tail = spilled[0]!;
    const head = viewOf(t.score, 1).items[3]!;
    expect(tail.kind === 'note' && tail.tie).toBe('stop');
    expect(head.kind === 'note' && head.tie).toBe('start');
  });

  it('T ties the previous note to the next one entered', () => {
    const s = open();
    type(s, '4', 'c', 't', 'c');
    const items = viewOf(s.score, 1).items;
    expect(items.map((item) => (item.kind === 'note' ? item.tie : 'x'))).toEqual(['start', 'stop']);
  });

  it('Backspace deletes the previous item and steps back; left and right move over entered notes', () => {
    const s = open();
    type(s, '4', 'c', 'd', 'e');
    type(s, 'Backspace');
    expect(notes(s.score, 1)).toEqual(['C5/4', 'D5/4']);
    expect(s.state.caret.onset).toBe(960);
    type(s, 'ArrowLeft');
    expect(s.state.caret.onset).toBe(480);
    type(s, 'ArrowRight');
    expect(s.state.caret.onset).toBe(960);
  });

  it('overwrites what is under the caret as one batch, and Enter skips over it', () => {
    const s = open();
    type(s, '4', 'c', 'd', 'e', 'f');
    type(s, 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft');
    expect(s.state.caret.onset).toBe(0);
    type(s, 'g');
    expect(notes(s.score, 1)).toEqual(['G4/4', 'D5/4', 'E5/4', 'F5/4']);
    const last = s.log[s.log.length - 1]!;
    expect(last.map((op) => op.type)).toEqual(['note.rm', 'note.add']);
    type(s, 'Enter');
    expect(s.state.caret.onset).toBe(960);
  });

  it('asks before adding a bar at the end, then adds it with bar.add', () => {
    const s = open({ barCount: 1 });
    type(s, '6', 'c');
    expect(s.state.atEnd).toBe(true);
    const before = s.score.bars.length;
    type(s, 'c');
    expect(s.score.bars.length).toBe(before);
    expect(s.messages[s.messages.length - 1]).toMatch(/Enter to add a bar/);
    type(s, 'Enter');
    expect(s.score.bars.length).toBe(before + 1);
    expect(s.state.atEnd).toBe(false);
    expect(s.state.caret.bar).toBe(2);
  });

  it('refuses a voice the staff does not have, and carries no ops for it', () => {
    const s = open();
    const result = stepInput(s.state, { type: 'voice', voice: 2 }, inputContext(s.score));
    expect(result.ops).toEqual([]);
    expect(result.message).toMatch(/Voice 2/);
  });
});

describe('the ghost', () => {
  it('previews the note at the caret as an ordinary score the one render path draws', () => {
    const s = open();
    type(s, '4', 'c');
    const ghost = ghostScore(s.score, s.state, inputContext(s.score))!;
    expect(viewOf(ghost, 1).items.map((item) => item.id)).toContain(GHOST_ID);
    expect(viewOf(s.score, 1).items.map((item) => item.id)).not.toContain(GHOST_ID);
  });
});
