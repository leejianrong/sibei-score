import { describe, expect, it } from 'vitest';
import { applyOperation, replay } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { TICKS_PER_QUARTER, formatKeySignature, formatPitch } from '@sibei/model';
import type { Chord, KeySignature, Note, Score } from '@sibei/model';

/**
 * The `transpose` op through the applier (V6, ADR-0016, ADR-0017). Pure, no store: everything
 * transposition decides — the respelling, the moved chord roots, the pins — is decided here, so it
 * is asserted here, replay included.
 */

const Q = TICKS_PER_QUARTER;
const EB: KeySignature = { tonic: 'E', alter: -1, mode: 'major' };

interface NoteSpec {
  target: string;
  pitch: string;
  pinned?: boolean;
}

/** Build a chart in C with the given notes and chords, keeping the *normalised* op log for replay. */
function chartInC(notes: NoteSpec[], chords: { target: string; text: string }[]): {
  score: Score;
  log: Operation[];
} {
  const log: Operation[] = [];
  let score: Score | null = null;
  const apply = (operation: Operation): void => {
    const applied = applyOperation(score, operation);
    score = applied.score;
    log.push(applied.operation);
  };

  apply({ type: 'score.create', payload: { id: 'chart', barCount: 8, key: { tonic: 'C', alter: 0, mode: 'major' } } });
  for (const note of notes) {
    apply({
      type: 'note.add',
      target: note.target,
      payload: { pitch: note.pitch, duration: { value: 4, dots: 0 }, ...(note.pinned ? { spellingPinned: true } : {}) },
    });
  }
  for (const chord of chords) {
    apply({ type: 'chord.set', target: chord.target, payload: { text: chord.text } });
  }
  if (score === null) throw new Error('empty chart');
  return { score, log };
}

const noteAt = (score: Score, barNumber: number, onset: number): Note => {
  const item = score.bars.find((bar) => bar.number === barNumber)?.items.find((i) => i.onset === onset);
  if (item === undefined || item.kind !== 'note') throw new Error(`no note at bar${barNumber} onset ${onset}`);
  return item;
};

const chordTextsOf = (score: Score, barNumber: number): string[] =>
  (score.bars.find((bar) => bar.number === barNumber)?.chords ?? []).map((c: Chord) => c.text);

const transpose = (to: KeySignature): Operation => ({ type: 'transpose', payload: { to } });

describe('transposing the melody (ADR-0017)', () => {
  it('respells C to Eb showing Bb and Ab, never A# or G# (the V6 demo)', () => {
    const { score } = chartInC(
      [
        { target: 'bar1.beat1', pitch: 'G4' },
        { target: 'bar1.beat2', pitch: 'F4' },
        { target: 'bar1.beat3', pitch: 'A4' },
        { target: 'bar1.beat4', pitch: 'C5' },
      ],
      [],
    );
    const moved = applyOperation(score, transpose(EB)).score;
    expect(formatPitch(noteAt(moved, 1, 0).pitch)).toBe('Bb4'); // G4 up a minor third
    expect(formatPitch(noteAt(moved, 1, Q).pitch)).toBe('Ab4'); // F4
    expect(formatPitch(noteAt(moved, 1, 2 * Q).pitch)).toBe('C5'); // A4
    expect(formatPitch(noteAt(moved, 1, 3 * Q).pitch)).toBe('Eb5'); // C5
  });

  it('changes the concert key signature to the target', () => {
    const { score } = chartInC([{ target: 'bar1.beat1', pitch: 'C4' }], []);
    const moved = applyOperation(score, transpose(EB)).score;
    expect(formatKeySignature(moved.meta.key)).toBe('Eb');
  });

  it('lists the notes and chords it touched in changed[]', () => {
    const { score } = chartInC([{ target: 'bar1.beat1', pitch: 'C4' }], [{ target: 'bar1.beat1', text: 'C7' }]);
    const applied = applyOperation(score, transpose(EB));
    expect(applied.changed).toEqual(['note-1', 'chord-1']);
  });
});

describe('transposing the chords with the melody (ADR-0016)', () => {
  it('moves chord roots and respells them by the destination key', () => {
    const { score } = chartInC(
      [],
      [
        { target: 'bar1.beat1', text: 'C7' },
        { target: 'bar1.beat3', text: 'G7' },
      ],
    );
    const moved = applyOperation(score, transpose(EB)).score;
    expect(chordTextsOf(moved, 1)).toEqual(['Eb7', 'Bb7']);
  });

  it('moves a slash-chord bass note too', () => {
    const { score } = chartInC([], [{ target: 'bar1.beat1', text: 'D7/F#' }]);
    const moved = applyOperation(score, transpose(EB)).score;
    expect(chordTextsOf(moved, 1)).toEqual(['F7/A']);
  });

  it('leaves N.C. and unparseable text verbatim, keeping the flag', () => {
    const { score } = chartInC(
      [],
      [
        { target: 'bar1.beat1', text: 'N.C.' },
        { target: 'bar1.beat3', text: 'solo break' },
      ],
    );
    const bar = score.bars.find((b) => b.number === 1)!;
    const flaggedBefore = bar.chords.map((c) => c.review.flagged);
    const moved = applyOperation(score, transpose(EB)).score;
    expect(chordTextsOf(moved, 1)).toEqual(['N.C.', 'solo break']);
    expect(moved.bars.find((b) => b.number === 1)!.chords.map((c) => c.review.flagged)).toEqual(flaggedBefore);
  });
});

describe('pins survive transposition (ADR-0017)', () => {
  it('keeps a pinned note on its interval spelling where the key would re-spell it', () => {
    const { score } = chartInC(
      [
        { target: 'bar1.beat1', pitch: 'G#4', pinned: true },
        { target: 'bar1.beat2', pitch: 'G#4' },
      ],
      [],
    );
    const moved = applyOperation(score, transpose(EB)).score;
    // Pinned: G#4 up a minor third is B4. Unpinned: the key writes the same pitch as Cb5.
    expect(formatPitch(noteAt(moved, 1, 0).pitch)).toBe('B4');
    expect(formatPitch(noteAt(moved, 1, Q).pitch)).toBe('Cb5');
  });

  it('keeps a pinned chord root on its interval spelling', () => {
    // A pinned G#7 (a secondary dominant spelled sharp) transposed C -> Eb rides the interval to
    // B7; unpinned, the flat key writes the same root as its flat-six, Cb7.
    let score: Score | null = null;
    const apply = (op: Operation): void => {
      score = applyOperation(score, op).score;
    };
    apply({ type: 'score.create', payload: { id: 'p', barCount: 2, key: { tonic: 'C', alter: 0, mode: 'major' } } });
    apply({ type: 'chord.set', target: 'bar1.beat1', payload: { text: 'G#7', spellingPinned: true } });
    apply({ type: 'chord.set', target: 'bar1.beat3', payload: { text: 'G#7' } });
    const moved = applyOperation(score!, transpose(EB)).score;
    expect(chordTextsOf(moved, 1)).toEqual(['B7', 'Cb7']);
  });
});

describe('transpose is a mutation on the one write path (ADR-0003)', () => {
  it('replays from the log to the identical transposed score, so it is undoable', () => {
    const { score, log } = chartInC(
      [
        { target: 'bar1.beat1', pitch: 'G4' },
        { target: 'bar2.beat1', pitch: 'E4', pinned: true },
      ],
      [{ target: 'bar1.beat1', text: 'Cmaj7' }],
    );
    const applied = applyOperation(score, transpose(EB));
    const full = [...log, applied.operation];
    expect(replay(full)).toEqual(applied.score);
  });

  it('round-trips a chart back to where it started when transposed there and back', () => {
    const { score } = chartInC([{ target: 'bar1.beat1', pitch: 'G4' }], [{ target: 'bar1.beat1', text: 'Dm7' }]);
    const there = applyOperation(score, transpose(EB)).score;
    const back = applyOperation(there, transpose({ tonic: 'C', alter: 0, mode: 'major' })).score;
    expect(formatPitch(noteAt(back, 1, 0).pitch)).toBe('G4');
    expect(chordTextsOf(back, 1)).toEqual(['Dm7']);
    expect(formatKeySignature(back.meta.key)).toBe('C');
  });
});
