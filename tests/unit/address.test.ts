import { describe, expect, it } from 'vitest';
import {
  AddressError,
  TICKS_PER_QUARTER,
  dur,
  formatAddress,
  formatAddressFailure,
  makeBar,
  makeChord,
  makeNote,
  makeRest,
  makeScore,
  orderedItems,
  parseAddress,
  resolveAddress,
  resolvePosition,
} from '@sibei/model';
import type { Score } from '@sibei/model';

/**
 * Address resolution (ADR-0007).
 *
 * The three forms, and the four rules that make musical positions safe: onsets only; the error
 * lists the bar's real onsets; a pickup is bar 0; and ordinals have a defined order even when
 * the bar's rhythm is invalid.
 */

const Q = TICKS_PER_QUARTER;

/**
 * Bar 0 is a pickup with one note on the last beat. Bar 1 is four quarters. Bar 2 has a rest in
 * the middle and two chords.
 */
function aScore(): Score {
  return makeScore({
    id: 'score-1',
    bars: [
      makeBar({
        id: 'bar-0',
        number: 0,
        items: [makeNote({ id: 'note-1', onset: 3 * Q, duration: dur(4), pitch: 'G4' })],
      }),
      makeBar({
        id: 'bar-1',
        number: 1,
        items: [
          makeNote({ id: 'note-2', onset: 0, duration: dur(4), pitch: 'Eb5' }),
          makeNote({ id: 'note-3', onset: Q, duration: dur(8), pitch: 'F5' }),
          makeNote({ id: 'note-4', onset: Q + Q / 2, duration: dur(8), pitch: 'G5' }),
          makeNote({ id: 'note-5', onset: 2 * Q, duration: dur(2), pitch: 'Ab5' }),
        ],
      }),
      makeBar({
        id: 'bar-2',
        number: 2,
        items: [
          makeNote({ id: 'note-6', onset: 0, duration: dur(2), pitch: 'Bb5' }),
          makeRest({ id: 'rest-1', onset: 2 * Q, duration: dur(4) }),
          makeNote({ id: 'note-7', onset: 3 * Q, duration: dur(4), pitch: 'C6' }),
        ],
        chords: [
          makeChord({ id: 'chord-1', onset: 0, text: 'Ebm7' }),
          makeChord({ id: 'chord-2', onset: 2 * Q, text: 'Ab7' }),
        ],
      }),
    ],
  });
}

describe('parsing', () => {
  it.each([
    ['bar12.beat3', { form: 'beat', bar: 12, beat: 3 }],
    ['bar12.beat2.5', { form: 'beat', bar: 12, beat: 2.5 }],
    ['bar0.beat4', { form: 'beat', bar: 0, beat: 4 }],
    ['bar12.n3', { form: 'ordinal', bar: 12, ordinal: 3 }],
    ['bar1.n1', { form: 'ordinal', bar: 1, ordinal: 1 }],
    ['note-17', { form: 'id', id: 'note-17' }],
    ['rest-4', { form: 'id', id: 'rest-4' }],
    ['chord-9', { form: 'id', id: 'chord-9' }],
  ])('reads %s', (text, expected) => {
    expect(parseAddress(text)).toEqual(expected);
  });

  it('tolerates surrounding whitespace, because a shell will add it', () => {
    expect(parseAddress('  bar3.n2 ')).toEqual({ form: 'ordinal', bar: 3, ordinal: 2 });
  });

  it.each([
    ['bar12'],
    ['12.beat3'],
    ['bar12.beat'],
    ['bar12.n'],
    ['bar12.n0'],
    ['bar12.beat0'],
    ['bar-12.beat3'],
    ['bar12.beat3.4.5'],
    ['barX.beat3'],
    ['note17'],
    ['Note-17'],
    [''],
    ['bar12.beat3 --pitch Bb4'],
  ])('rejects %s', (text) => {
    expect(() => parseAddress(text)).toThrow(AddressError);
  });

  it('says what an address looks like when it cannot read one', () => {
    // An agent that gets this back should not need to read the docs to recover.
    expect(() => parseAddress('bar12')).toThrow(/Expected bar12\.beat3, bar12\.n3, or an id/);
  });

  it('round-trips through formatting', () => {
    for (const text of ['bar12.beat3', 'bar12.beat2.5', 'bar12.n3', 'note-17']) {
      expect(formatAddress(parseAddress(text))).toBe(text);
    }
  });
});

describe('the beat form', () => {
  it('resolves an onset', () => {
    const resolved = resolveAddress(aScore(), 'bar1.beat3');
    expect(resolved.target.id).toBe('note-5');
    expect(resolved.bar.number).toBe(1);
    expect(resolved.onset).toBe(2 * Q);
  });

  it('resolves a fractional beat', () => {
    expect(resolveAddress(aScore(), 'bar1.beat2.5').target.id).toBe('note-4');
  });

  it('addresses a pickup as bar 0, so bar 1 is the first full bar', () => {
    // A musician counts this way, and the layout engine keeps the pickup outside the grid.
    expect(resolveAddress(aScore(), 'bar0.beat4').target.id).toBe('note-1');
    expect(resolveAddress(aScore(), 'bar1.beat1').target.id).toBe('note-2');
  });

  it('resolves a rest, which is a first-class object and not an implied gap', () => {
    expect(resolveAddress(aScore(), 'bar2.beat3').target.id).toBe('rest-1');
  });

  it('resolves a chord by beat, since two chords in one bar is routine', () => {
    expect(resolveAddress(aScore(), 'bar2.beat3', 'chord').target.id).toBe('chord-2');
    expect(resolveAddress(aScore(), 'bar2.beat1', 'chord').target.id).toBe('chord-1');
  });
});

describe('onsets only — the rule that makes positions safe', () => {
  it('refuses a beat that is not an onset instead of snapping to the nearest thing', () => {
    // Snapping would let an agent edit the wrong note and never find out. This cannot.
    expect(() => resolveAddress(aScore(), 'bar1.beat4')).toThrow(AddressError);
  });

  it('lists the bar’s real onsets, which is what makes the strict rule usable', () => {
    try {
      resolveAddress(aScore(), 'bar1.beat4');
      expect.unreachable('should not resolve');
    } catch (error) {
      const failure = (error as AddressError).failure;
      expect(failure).toEqual({
        kind: 'not-an-onset',
        bar: 1,
        beat: 4,
        onsets: [1, 2, 2.5, 3],
        looking: 'item',
      });
      expect((error as AddressError).message).toBe(
        'bar 1 has no item at beat 4; onsets are 1, 2, 2.5, 3',
      );
    }
  });

  it('refuses a beat inside a note that started earlier', () => {
    // note-5 is a half note starting at beat 3, so beat 4 is mid-note. Mid-note is not an onset.
    expect(() => resolveAddress(aScore(), 'bar1.beat4')).toThrow(/onsets are 1, 2, 2\.5, 3/);
  });

  it('lists chord onsets, not note onsets, when a chord was what was asked for', () => {
    expect(() => resolveAddress(aScore(), 'bar2.beat2', 'chord')).toThrow(
      'bar 2 has no chord at beat 2; onsets are 1, 3',
    );
  });

  it('says the bar is empty rather than listing nothing', () => {
    const score = makeScore({ id: 'score-1', bars: [makeBar({ id: 'bar-1', number: 1 })] });
    expect(() => resolveAddress(score, 'bar1.beat1')).toThrow(
      'bar 1 has no item at beat 1; the bar is empty',
    );
  });

  it('refuses a bar that is not there, and lists the bars that are', () => {
    expect(() => resolveAddress(aScore(), 'bar9.beat1')).toThrow(
      'there is no bar 9; bars are 0, 1, 2',
    );
  });

  it('says so plainly when the score has no bars at all', () => {
    const score = makeScore({ id: 'score-1' });
    expect(() => resolveAddress(score, 'bar1.beat1')).toThrow(
      'there is no bar 1; the score has no bars yet',
    );
  });
});

describe('the ordinal form', () => {
  it('counts from 1, in onset order', () => {
    const score = aScore();
    expect(resolveAddress(score, 'bar1.n1').target.id).toBe('note-2');
    expect(resolveAddress(score, 'bar1.n3').target.id).toBe('note-4');
    expect(resolveAddress(score, 'bar1.n4').target.id).toBe('note-5');
  });

  it('counts rests, so a rest is reachable by position', () => {
    // ADR-0007 glosses `n3` as "the third note in bar 12", which leaves open whether a rest
    // takes a slot. It has to: a rest is a first-class object (Q35, ADR-0013), and if the
    // ordinal space skipped rests there would be no positional way to address one at all.
    // The `kind` argument is what recovers the narrower reading — see below.
    const score = aScore();
    expect(resolveAddress(score, 'bar2.n1').target.id).toBe('note-6');
    expect(resolveAddress(score, 'bar2.n2').target.id).toBe('rest-1');
    expect(resolveAddress(score, 'bar2.n3').target.id).toBe('note-7');
  });

  it('says how many items the bar has when the ordinal runs off the end', () => {
    expect(() => resolveAddress(aScore(), 'bar1.n5')).toThrow(
      'bar 1 has 4 items, so there is no n5',
    );
  });

  it('gets the singular right, because an error a human reads should read like one', () => {
    expect(() => resolveAddress(aScore(), 'bar0.n2')).toThrow(
      'bar 0 has 1 item, so there is no n2',
    );
  });

  it('says the bar is empty rather than claiming it has 0 items', () => {
    const score = makeScore({ id: 'score-1', bars: [makeBar({ id: 'bar-1', number: 1 })] });
    expect(() => resolveAddress(score, 'bar1.n1')).toThrow(
      'bar 1 has nothing in it, so there is no n1',
    );
  });

  it('does not address chords, which are addressed by beat', () => {
    expect(() => resolveAddress(aScore(), 'bar2.n1', 'chord')).toThrow(
      'bar2.n1 is a note, not a chord',
    );
  });
});

describe('ordinals in a metrically invalid bar (ADR-0013)', () => {
  /**
   * A bar stored as written and never repaired: the items are out of onset order, two share an
   * onset, and together they overflow the meter. ADR-0007 says ordering is by onset then by
   * insertion order, and this is the bar that makes the second half of that mean something.
   */
  function aMessyBar(): Score {
    return makeScore({
      id: 'score-1',
      bars: [
        makeBar({
          id: 'bar-1',
          number: 1,
          items: [
            makeNote({ id: 'note-late', onset: 3 * Q, duration: dur(1), pitch: 'C5' }),
            makeNote({ id: 'note-early', onset: 0, duration: dur(4), pitch: 'D5' }),
            makeNote({ id: 'note-tied-a', onset: Q, duration: dur(4), pitch: 'E5' }),
            makeNote({ id: 'note-tied-b', onset: Q, duration: dur(4), pitch: 'G5' }),
          ],
        }),
      ],
    });
  }

  it('orders by onset even when the stored array is not in onset order', () => {
    expect(orderedItems(aMessyBar().bars[0]!).map((item) => item.id)).toEqual([
      'note-early',
      'note-tied-a',
      'note-tied-b',
      'note-late',
    ]);
  });

  it('breaks a tie on onset by insertion order, and does so stably', () => {
    const score = aMessyBar();
    expect(resolveAddress(score, 'bar1.n2').target.id).toBe('note-tied-a');
    expect(resolveAddress(score, 'bar1.n3').target.id).toBe('note-tied-b');
    // Same answer every time: the ordering is defined, not incidental.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(resolveAddress(aMessyBar(), 'bar1.n3').target.id).toBe('note-tied-b');
    }
  });

  it('resolves an overflowing bar without repairing or refusing it', () => {
    // Nothing in the pipeline may repair or refuse a bar. Resolution included.
    expect(resolveAddress(aMessyBar(), 'bar1.n4').target.id).toBe('note-late');
  });

  it('lists a shared onset once when reporting a miss', () => {
    expect(() => resolveAddress(aMessyBar(), 'bar1.beat3')).toThrow(
      'bar 1 has no item at beat 3; onsets are 1, 2, 4',
    );
  });
});

describe('the id form', () => {
  it('resolves a note, a rest and a chord', () => {
    const score = aScore();
    expect(resolveAddress(score, 'note-7').bar.number).toBe(2);
    expect(resolveAddress(score, 'rest-1').target.id).toBe('rest-1');
    expect(resolveAddress(score, 'chord-2', 'chord').onset).toBe(2 * Q);
  });

  it('finds an object wherever in the score it sits', () => {
    expect(resolveAddress(aScore(), 'note-1').bar.number).toBe(0);
  });

  it('refuses an id that is not in this score', () => {
    expect(() => resolveAddress(aScore(), 'note-999')).toThrow(
      'there is nothing with the id "note-999" in this score',
    );
  });

  it('is unambiguous, which is the whole reason the model carries ids', () => {
    // Every id in the fixture resolves to exactly the object that owns it.
    const score = aScore();
    for (const bar of score.bars) {
      for (const item of [...bar.items, ...bar.chords]) {
        const kind = 'kind' in item ? item.kind : 'chord';
        expect(resolveAddress(score, item.id, kind).target).toBe(item);
      }
    }
  });
});

describe('asking for the wrong kind of thing', () => {
  it('says what is there instead, rather than resolving it anyway', () => {
    expect(() => resolveAddress(aScore(), 'bar2.beat3', 'note')).toThrow(
      'bar2.beat3 is a rest, not a note',
    );
    expect(() => resolveAddress(aScore(), 'bar2.beat1', 'rest')).toThrow(
      'bar2.beat1 is a note, not a rest',
    );
  });

  it('treats `item` as notes and rests but not chords, since they share the ordinal space', () => {
    expect(resolveAddress(aScore(), 'bar2.n2', 'item').target.id).toBe('rest-1');
    expect(() => resolveAddress(aScore(), 'chord-1', 'item')).toThrow(
      'chord-1 is a chord, not an item',
    );
  });
});

describe('resolving a place rather than an object', () => {
  it('accepts a beat that is not an onset, because that is where a new note goes', () => {
    // The strict rule would be backwards for an `add`: an empty beat is the point.
    const position = resolvePosition(aScore(), 'bar1.beat4');
    expect(position.bar.number).toBe(1);
    expect(position.onset).toBe(3 * Q);
  });

  it('still refuses a bar that does not exist', () => {
    expect(() => resolvePosition(aScore(), 'bar9.beat1')).toThrow('there is no bar 9');
  });

  it('resolves an object address to where that object sits', () => {
    expect(resolvePosition(aScore(), 'bar1.n3').onset).toBe(Q + Q / 2);
    expect(resolvePosition(aScore(), 'note-5').onset).toBe(2 * Q);
  });

  it('places a beat past the end of the bar without complaint, because ADR-0013 stores it', () => {
    // Adding a note that overflows the meter is a flagged bar, never a rejected write.
    expect(resolvePosition(aScore(), 'bar1.beat9').onset).toBe(8 * Q);
  });
});

describe('the failure messages', () => {
  it('are rendered from the structure, so both surfaces print the same words', () => {
    expect(
      formatAddressFailure({ kind: 'not-an-onset', bar: 12, beat: 3, onsets: [1, 2.5, 4], looking: 'note' }),
    ).toBe('bar 12 has no note at beat 3; onsets are 1, 2.5, 4');
  });

  it('print a whole beat without a decimal point', () => {
    expect(
      formatAddressFailure({ kind: 'not-an-onset', bar: 1, beat: 2, onsets: [1, 3], looking: 'item' }),
    ).toContain('beat 2;');
  });

  it('cover every failure kind, so none can reach a user as undefined', () => {
    const failures = [
      { kind: 'syntax', text: 'nope' },
      { kind: 'no-such-bar', bar: 3, present: [1, 2] },
      { kind: 'not-an-onset', bar: 1, beat: 2, onsets: [1], looking: 'note' },
      { kind: 'no-such-ordinal', bar: 1, ordinal: 9, count: 2 },
      { kind: 'no-such-id', id: 'note-9' },
      { kind: 'wrong-kind', found: 'rest', looking: 'note', at: 'bar1.n1' },
      { kind: 'not-a-position', text: 'note-1' },
    ] as const;
    for (const failure of failures) {
      const message = formatAddressFailure(failure);
      expect(message).toBeTruthy();
      expect(message).not.toContain('undefined');
    }
  });
});
