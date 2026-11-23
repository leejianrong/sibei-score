import { describe, expect, it } from 'vitest';
import { OPERATION_VERSION, applyOperation, OperationError, replay, replayLog } from '@sibei/api';
import type { ControlOperation, Operation, StoredOperation } from '@sibei/api';
import {
  AddressError,
  allStaves,
  barViews,
  formatPitch,
  parseAddress,
  projectScore,
  resolveAddress,
  reviewSummary,
  scoreMetrics,
  voiceIndexes,
  notesOf,
} from '@sibei/model';
import type { AddressFailure, Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';

/**
 * Staves, voices and parts through the applier (ADR-0041 section 2, SIB2-226): every op, every address form, the
 * strictness rule, per-voice metric validity, and replay/undo. The "old payloads replay unchanged" half is
 * `model-v3-replay.test.ts` staying green unmodified, plus the single-staff cases here that never name a staff.
 */

const q = { value: 4, dots: 0 } as const;
const note = (target: string, pitch = 'C5', duration: { value: number; dots: number } = q): Operation =>
  ({ type: 'note.add', target, payload: { pitch, duration } }) as Operation;

function run(operations: Operation[]): { score: Score; log: Operation[] } {
  const log: Operation[] = [];
  let score: Score | null = null;
  for (const operation of operations) {
    const applied = applyOperation(score, operation);
    score = applied.score;
    log.push(applied.operation);
  }
  return { score: score!, log };
}

function failure(operations: Operation[]): AddressFailure | string {
  try {
    run(operations);
  } catch (error) {
    if (error instanceof OperationError) {
      return error.failure.kind === 'address' ? error.failure.failure : (error.failure as { detail: string }).detail;
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

const create: Operation = { type: 'score.create', payload: { id: 'big', barCount: 4 } };
/** Piano: staff 1 (treble) with voices 1 and 2, staff 2 (bass). Plus a bass part. */
const twoStaves: Operation[] = [
  create,
  { type: 'part.add', payload: { name: 'Bass', instrument: 32, clef: 'bass' } },
  { type: 'voice.add', target: 's1' },
];

const pitchesAt = (score: Score, select: { staff?: string; voice?: number }): string[] =>
  barViews(score, select).flatMap((bar) => notesOf(bar).map((n) => formatPitch(n.pitch)));

describe('part.add, instrument.set, staff.add', () => {
  it('adds a part with one staff, recording its ids, and names and tunes it', () => {
    const { score, log } = run([
      create,
      { type: 'part.add', payload: { name: 'Bass', instrument: 32, transposition: -12, clef: 'bass' } },
    ]);
    expect(score.parts).toHaveLength(2);
    expect(score.parts[1]).toMatchObject({ id: 'part-2', name: 'Bass', instrument: 32, transposition: -12 });
    expect(score.parts[1]!.staves[0]).toMatchObject({ id: 'staff-2', type: 'standard', clef: 'bass' });
    // Every bar of the grid has an empty voice in the new staff, and the ids are recorded for replay.
    expect(score.parts[1]!.staves[0]!.bars).toHaveLength(4);
    expect(log[1]).toMatchObject({ payload: { id: 'part-2', staffId: 'staff-2' } });
  });

  it('takes the staff type as a tag, defaulting percussion staves to the percussion clef', () => {
    const { score } = run([create, { type: 'part.add', payload: { name: 'Drums', staffType: 'percussion' } }]);
    expect(score.parts[1]!.staves[0]).toMatchObject({ type: 'percussion', clef: 'percussion' });
    expect(failure([create, { type: 'part.add', payload: { staffType: 'banjo' as 'tab' } }])).toMatch(/staff type/);
  });

  it('adds a staff to a part (the last part by default) and sets the instrument later', () => {
    const { score } = run([
      create,
      { type: 'staff.add', target: 'p1', payload: { clef: 'bass' } },
      { type: 'instrument.set', payload: { name: 'Piano', instrument: 0 } },
    ]);
    expect(score.parts).toHaveLength(1);
    expect(score.parts[0]!.staves.map((s) => [s.id, s.clef])).toEqual([['staff-1', 'treble'], ['staff-2', 'bass']]);
    expect(score.parts[0]).toMatchObject({ name: 'Piano', instrument: 0 });
  });

  it('refuses a bad program, transposition or clef, and an empty instrument.set', () => {
    expect(failure([create, { type: 'instrument.set', payload: { instrument: 200 } }])).toMatch(/0 to 127/);
    expect(failure([create, { type: 'instrument.set', payload: { transposition: 1.5 } }])).toMatch(/semitones/);
    expect(failure([create, { type: 'instrument.set', payload: {} }])).toMatch(/at least one/);
    expect(failure([create, { type: 'staff.add', payload: { clef: 'soprano' as 'alto' } }])).toMatch(/clef/);
  });

  it('needs a part named when instrument.set is ambiguous', () => {
    expect(failure([...twoStaves, { type: 'instrument.set', payload: { name: 'X' } }])).toMatch(/2 parts.*p1, p2/);
  });
});

describe('voice.add, voice.rm', () => {
  it('adds the lowest free voice to every bar, to at most four', () => {
    const { score } = run([
      create,
      { type: 'voice.add' },
      { type: 'voice.add', target: 's1' },
      { type: 'voice.add', target: 's1' },
    ]);
    expect(voiceIndexes(allStaves(score)[0]!)).toEqual([1, 2, 3, 4]);
    expect(allStaves(score)[0]!.bars.every((b) => b.voices.length === 4)).toBe(true);
    expect(failure([create, { type: 'voice.add' }, { type: 'voice.add' }, { type: 'voice.add' }, { type: 'voice.add' }])).toMatch(
      /4 voices/,
    );
  });

  it('refuses voice.add without a staff once there are several', () => {
    expect(failure([...twoStaves, { type: 'voice.add' }])).toMatch(/2 staves.*s1, s2/);
  });

  it('removes an empty voice, refuses one with music unless forced, and never removes voice 1', () => {
    const base = [...twoStaves, note('s1.v2.bar1.beat1', 'E4')];
    expect(run([...twoStaves, { type: 'voice.rm', target: 's1.v2' }]).score.parts[0]!.staves[0]!.bars[0]!.voices).toHaveLength(1);
    expect(failure([...base, { type: 'voice.rm', target: 's1.v2' }])).toMatch(/holds notes.*force/);
    const forced = run([...base, { type: 'voice.rm', target: 's1.v2', payload: { force: true } }]).score;
    expect(voiceIndexes(allStaves(forced)[0]!)).toEqual([1]);
    expect(failure([...twoStaves, { type: 'voice.rm', target: 's1.v1' }])).toMatch(/voice 1/);
    expect(failure([...twoStaves, { type: 'voice.rm', target: 's1' }])).toMatch(/name the voice/);
  });

  it('drops a slur when the force-removed voice held one of its notes', () => {
    const { score } = run([
      ...twoStaves,
      note('s1.v1.bar1.beat1', 'C5'),
      note('s1.v2.bar1.beat1', 'E4'),
      note('s1.v2.bar1.beat2', 'F4'),
      { type: 'slur.set', target: 's1.v2.bar1.n1', payload: { to: 's1.v2.bar1.n2' } },
      { type: 'voice.rm', target: 's1.v2', payload: { force: true } },
    ]);
    expect(score.spanners ?? []).toEqual([]);
  });
});

describe('part.rm, staff.rm', () => {
  it('keeps one part and one staff, and one staff in each part', () => {
    expect(failure([create, { type: 'part.rm', target: 'p1' }])).toMatch(/at least one part/);
    expect(failure([create, { type: 'staff.rm', target: 's1' }])).toMatch(/at least one staff/);
    expect(failure([...twoStaves, { type: 'staff.rm', target: 's2' }])).toMatch(/only staff of part part-2/);
  });

  it('refuses to remove a part or staff holding music unless forced, naming it by label or id', () => {
    const withMusic = [...twoStaves, note('s2.bar1.beat1', 'C3')];
    expect(failure([...withMusic, { type: 'part.rm', target: 'p2' }])).toMatch(/holds notes.*force/);
    const gone = run([...withMusic, { type: 'part.rm', target: 'part-2', payload: { force: true } }]).score;
    expect(gone.parts).toHaveLength(1);
    const piano = [create, { type: 'staff.add', target: 'p1' } as Operation, note('s2.bar1.beat1', 'C3')];
    expect(failure([...piano, { type: 'staff.rm', target: 's2' }])).toMatch(/force/);
    const removed = run([...piano, { type: 'staff.rm', target: 'staff-2', payload: { force: true } }]).score;
    expect(allStaves(removed)).toHaveLength(1);
    // Removing an empty one needs no force.
    expect(allStaves(run([create, { type: 'staff.add', target: 'p1' }, { type: 'staff.rm', target: 's2' }]).score)).toHaveLength(1);
  });
});

describe('clef.set', () => {
  it('sets a staff clef, a change at a bar, and clears the change', () => {
    const set = run([...twoStaves, { type: 'clef.set', target: 's1', payload: { clef: 'alto' } }, { type: 'clef.set', target: 's2.bar3', payload: { clef: 'treble' } }]).score;
    const [s1, s2] = allStaves(set);
    expect(s1!.clef).toBe('alto');
    expect(s2!.clef).toBe('bass');
    expect(s2!.bars[2]!.clef).toBe('treble');
    expect(s2!.bars.filter((b) => b.clef !== undefined)).toHaveLength(1);
    const cleared = run([...twoStaves, { type: 'clef.set', target: 's2.bar3', payload: { clef: 'treble' } }, { type: 'clef.set', target: 's2.bar3', payload: { clef: null } }]).score;
    expect(allStaves(cleared)[1]!.bars.every((b) => b.clef === undefined)).toBe(true);
  });

  it('refuses a voice, a bare bar, or clearing an opening clef', () => {
    expect(failure([...twoStaves, { type: 'clef.set', target: 's1.v1', payload: { clef: 'bass' } }])).toMatch(/clef set takes a staff/);
    expect(failure([...twoStaves, { type: 'clef.set', target: 'bar2', payload: { clef: 'bass' } }])).toMatch(/clef set takes a staff/);
    expect(failure([...twoStaves, { type: 'clef.set', target: 's1', payload: { clef: null } }])).toMatch(/opening clef/);
    expect(failure([...twoStaves, { type: 'clef.set', target: 's9', payload: { clef: 'bass' } }])).toMatchObject({ kind: 'no-such-staff' });
  });
});

describe('addresses: strict and qualified (ADR-0007, ADR-0041)', () => {
  it('parses the qualifier forms', () => {
    expect(parseAddress('s2.v2.bar12.n3')).toEqual({ form: 'ordinal', bar: 12, ordinal: 3, staff: 2, voice: 2 });
    expect(parseAddress('s2.bar12.beat3')).toEqual({ form: 'beat', bar: 12, beat: 3, staff: 2 });
    expect(parseAddress('v2.bar1.n1')).toEqual({ form: 'ordinal', bar: 1, ordinal: 1, voice: 2 });
    expect(parseAddress('s2.bar5')).toEqual({ form: 'bar', bar: 5, staff: 2 });
    expect(parseAddress('s2.v3')).toEqual({ form: 'staff', staff: 2, voice: 3 });
    expect(parseAddress('note-17')).toEqual({ form: 'id', id: 'note-17' });
    expect(() => parseAddress('s0.bar1.n1')).toThrow(AddressError);
    expect(() => parseAddress('s2.note-1')).toThrow(AddressError);
  });

  it('keeps a bare address meaning staff 1 voice 1 while the score has one of each', () => {
    const { score } = run([create, note('bar1.beat1', 'D5')]);
    expect(resolveAddress(score, 'bar1.beat1').select).toMatchObject({ staff: 'staff-1', voice: 1 });
    expect(resolveAddress(score, 'bar1.n1').target.id).toBe('note-1');
    // ...and the qualified spelling of the same thing agrees.
    expect(resolveAddress(score, 's1.v1.bar1.n1').target.id).toBe('note-1');
  });

  it('is an error listing the candidates when more than one could match, never a snap', () => {
    const { score } = run([...twoStaves, note('s1.v1.bar1.beat1', 'C5')]);
    try {
      resolveAddress(score, 'bar1.n1');
      throw new Error('should refuse');
    } catch (error) {
      const { failure: f } = error as AddressError;
      expect(f).toMatchObject({ kind: 'ambiguous' });
      expect((f as unknown as { candidates: string[] }).candidates).toEqual(['s1.v1.bar1.n1', 's1.v2.bar1.n1', 's2.v1.bar1.n1']);
      expect((error as Error).message).toContain('s1.v2.bar1.n1');
    }
    // A staff qualifier alone is still ambiguous across its voices, and lists only that staff's.
    expect(() => resolveAddress(score, 's1.bar1.n1')).toThrow(/s1\.v1\.bar1\.n1, s1\.v2\.bar1\.n1/);
    // A voice qualifier alone is ambiguous across staves.
    expect(() => resolveAddress(score, 'v1.bar1.n1')).toThrow(/s1\.v1\.bar1\.n1, s2\.v1\.bar1\.n1/);
  });

  it('refuses an ambiguous note.add rather than writing to the wrong staff', () => {
    expect(failure([...twoStaves, note('bar1.beat1')])).toMatchObject({ kind: 'ambiguous' });
    expect(failure([...twoStaves, note('s3.bar1.beat1')])).toMatchObject({ kind: 'no-such-staff', staff: 3, count: 2 });
    expect(failure([...twoStaves, note('s2.v2.bar1.beat1')])).toMatchObject({ kind: 'no-such-voice', staff: 2, voice: 2, present: [1] });
  });

  it('resolves ids anywhere, and needs no qualifier for chords or text', () => {
    const { score } = run([
      ...twoStaves,
      note('s2.v1.bar2.beat1', 'C3'),
      { type: 'chord.set', target: 'bar1.beat1', payload: { text: 'Cmaj7' } },
      { type: 'text.set', target: 'bar1.beat1', payload: { text: 'rit.' } },
    ]);
    const bass = resolveAddress(score, 'note-1');
    expect(bass.select).toMatchObject({ staff: 'staff-2', voice: 1 });
    expect(resolveAddress(score, 'bar1.beat1', 'chord').target).toMatchObject({ text: 'Cmaj7' });
    expect(() => run([...twoStaves, { type: 'chord.rm', target: 'bar1.beat1' }])).toThrow(/no chord/);
  });
});

describe('content ops on a chosen staff and voice', () => {
  const built = (): Score =>
    run([
      ...twoStaves,
      note('s1.v1.bar1.beat1', 'C5'),
      note('s1.v2.bar1.beat1', 'E4'),
      note('s2.bar1.beat1', 'C3', { value: 2, dots: 0 }),
    ]).score;

  it('keeps each staff and voice to itself, allowing the same onset in different voices', () => {
    const score = built();
    expect(pitchesAt(score, {})).toEqual(['C5']);
    expect(pitchesAt(score, { staff: 'staff-1', voice: 2 })).toEqual(['E4']);
    expect(pitchesAt(score, { staff: 'staff-2', voice: 1 })).toEqual(['C3']);
    // ...and a second note in one voice at one onset joins a chord when the duration matches, else it is refused.
    expect(failure([...twoStaves, note('s1.v1.bar1.beat1'), note('s1.v1.bar1.beat1', 'D5', { value: 8, dots: 0 })])).toMatch(/share one duration/);
  });

  it('edits and removes by qualified address or by id', () => {
    const score = built();
    const set = applyOperation(score, { type: 'note.set', target: 's1.v2.bar1.n1', payload: { pitch: 'F4' } }).score;
    expect(pitchesAt(set, { staff: 'staff-1', voice: 2 })).toEqual(['F4']);
    expect(pitchesAt(set, {})).toEqual(['C5']);
    const removed = applyOperation(set, { type: 'note.rm', target: 'note-3' }).score;
    expect(pitchesAt(removed, { staff: 'staff-2', voice: 1 })).toEqual([]);
  });

  it('brackets tuplets, fermatas, graces and slurs inside one voice, and slurs across staves', () => {
    let score = run([
      ...twoStaves,
      note('s2.bar1.beat1', 'C3', { value: 8, dots: 0 }),
      note('s2.bar1.beat1.5', 'D3', { value: 8, dots: 0 }),
      note('s2.bar1.beat2', 'E3', { value: 8, dots: 0 }),
    ]).score;
    score = applyOperation(score, { type: 'tuplet.set', target: 's2.bar1.n1', payload: { actual: 3, normal: 2 } }).score;
    expect(barViews(score, { staff: 'staff-2' })[0]!.tuplets).toHaveLength(1);
    expect(barViews(score, {})[0]!.tuplets).toHaveLength(0);
    score = applyOperation(score, { type: 'fermata.set', target: 's2.bar1.n1', payload: {} }).score;
    score = applyOperation(score, { type: 'grace.add', target: 's2.bar1.n2', payload: { pitch: 'B2' } }).score;
    expect(barViews(score, { staff: 'staff-2' })[0]!.items[1]).toHaveProperty('graces');
    score = applyOperation(score, note('s1.v1.bar2.beat1', 'C5')).score;
    // A slur from the bass staff to the treble staff's later bar reads forward through the score.
    score = applyOperation(score, { type: 'slur.set', target: 's2.bar1.n1', payload: { to: 's1.v1.bar2.n1' } }).score;
    expect(score.spanners).toHaveLength(1);
  });
});

describe('metric validity per voice (ADR-0013, ADR-0041 section 3)', () => {
  const full = (target: string): Operation[] => [1, 2, 3, 4].map((beat) => note(`${target}.beat${beat}`));

  it('allows an empty voice, and flags a bar when any voice fails to fill it', () => {
    const filled = run([...twoStaves, ...full('s1.v1.bar1')]).score;
    expect(scoreMetrics(filled).every((m) => m.valid)).toBe(true);
    expect(reviewSummary(filled).invalidBars).toEqual([]);

    // Voice 2 is short: the bar is flagged even though voice 1 fills it.
    const short = run([...twoStaves, ...full('s1.v1.bar1'), note('s1.v2.bar1.beat1', 'E4')]).score;
    expect(scoreMetrics(short)[0]).toMatchObject({ status: 'under', valid: false });
    expect(reviewSummary(short).invalidBars).toEqual([1]);
    expect(projectScore(short)).toMatch(/bar1!/);

    // A short bass staff counts too.
    const bass = run([...twoStaves, ...full('s1.v1.bar1'), note('s2.bar1.beat1', 'C3')]).score;
    expect(reviewSummary(bass).invalidBars).toEqual([1]);
    // ...and storing it was never refused.
    expect(bass.bars).toHaveLength(4);
  });
});

describe('score-wide ops reach every staff', () => {
  it('transposes every staff and voice once, and chords once', () => {
    const { score } = run([
      ...twoStaves,
      note('s1.v1.bar1.beat1', 'C5'),
      note('s1.v2.bar1.beat1', 'E4'),
      note('s2.bar1.beat1', 'G2'),
      { type: 'chord.set', target: 'bar1.beat1', payload: { text: 'C' } },
      { type: 'transpose', payload: { to: { tonic: 'D', alter: 0, mode: 'major' } } },
    ]);
    expect(pitchesAt(score, {})).toEqual(['D5']);
    expect(pitchesAt(score, { staff: 'staff-1', voice: 2 })).toEqual(['F#4']);
    expect(pitchesAt(score, { staff: 'staff-2', voice: 1 })).toEqual(['A2']);
    expect(barViews(score)[0]!.chords[0]!.text).toBe('D');
  });

  it('bar.add keeps every staff aligned with the grid, and bar.rm refuses a bar the second staff holds', () => {
    const base = [...twoStaves, note('s2.bar2.beat1', 'C3')];
    const added = run([...base, { type: 'bar.add', target: 'bar1' }]).score;
    expect(allStaves(added).every((s) => s.bars.length === 5)).toBe(true);
    expect(pitchesAt(added, { staff: 'staff-2' })).toEqual(['C3']);
    expect(barViews(added, { staff: 'staff-2' })[2]!.items).toHaveLength(1);
    expect(failure([...base, { type: 'bar.rm', target: 'bar2' }])).toMatch(/holds notes or rests/);
  });
});

describe('replay and undo (ADR-0003)', () => {
  const ops: Operation[] = [
    ...twoStaves,
    note('s1.v2.bar1.beat1', 'E4'),
    { type: 'clef.set', target: 's2.bar2', payload: { clef: 'treble' } },
    { type: 'staff.add', target: 'p2' },
    { type: 'instrument.set', target: 'p1', payload: { name: 'Piano', instrument: 0 } },
    { type: 'voice.rm', target: 's1.v2', payload: { force: true } },
  ];

  it('replays a log of structure ops from empty to the same document, from the recorded ids', () => {
    const { score, log } = run(ops);
    expect(replay(log)).toEqual(score);
    expect(JSON.stringify(replay(log))).toBe(JSON.stringify(score));
  });

  it('undoes and redoes structure ops as one unit each, like any batch', () => {
    const { log } = run(ops);
    const stored: StoredOperation[] = [];
    let seq = 1;
    const push = (batch: number, operation: Operation | ControlOperation): void => {
      stored.push({ seq: seq++, batch, version: OPERATION_VERSION, operation, createdAt: '2026-11-23T00:00:00Z' });
    };
    log.forEach((operation, index) => push(index + 1, operation));
    const full = replayLog(stored)!;
    push(log.length + 1, { type: 'undo' });
    const undone = replayLog(stored)!;
    // The undone force-removal brings voice 2 and its note back.
    expect(voiceIndexes(allStaves(full)[0]!)).toEqual([1]);
    expect(voiceIndexes(allStaves(undone)[0]!)).toEqual([1, 2]);
    expect(pitchesAt(undone, { staff: 'staff-1', voice: 2 })).toEqual(['E4']);
    push(log.length + 2, { type: 'redo' });
    expect(replayLog(stored)).toEqual(full);
  });
});

describe('the projection (ADR-0009)', () => {
  const { score } = run([
    ...twoStaves,
    { type: 'instrument.set', target: 'p1', payload: { name: 'Piano', instrument: 0 } },
    note('s1.v1.bar1.beat1', 'C5'),
    note('s1.v2.bar1.beat1', 'E4'),
    note('s2.bar1.beat1', 'C3'),
    { type: 'clef.set', target: 's2.bar3', payload: { clef: 'treble' } },
    { type: 'chord.set', target: 'bar1.beat1', payload: { text: 'Cmaj7' } },
  ]);
  const text = projectScore(score);

  it('lists the parts, staves and voices once, and each extra voice under its qualifier', () => {
    expect(text).toContain('part p1 "Piano" gm0');
    expect(text).toContain('s1 treble  v1 v2');
    expect(text).toContain('s2 bass  v1  bar3 treble');
    expect(text).toMatch(/\ns1\.v2\n\s+bar1\s+n1 e4\/4/);
    expect(text).toMatch(/\ns2\.v1\n\s+bar1\s+n1 c3\/4/);
    expect(text).toContain('Address: s1.v1.bar1.n2');
  });

  it('prints addresses that resolve', () => {
    expect(resolveAddress(score, 's2.v1.bar1.n1').target).toMatchObject({ pitch: { step: 'C', octave: 3 } });
  });

  it('leaves a one-staff, one-voice chart exactly as it was', () => {
    const plain = run([create, note('bar1.beat1', 'C5'), { type: 'chord.set', target: 'bar1.beat1', payload: { text: 'C' } }]).score;
    const printed = projectScore(plain);
    expect(printed).not.toMatch(/part p|\bs1\b|staff, voice/);
    expect(printed).toContain('Address: bar1.n1  or  bar1.beat1');
  });
});

describe('a multi-staff score does not crash layout or the engraver (staff 1 voice 1 is drawn for now)', () => {
  it('renders to SVG', () => {
    const { score } = run([
      ...twoStaves,
      ...[1, 2, 3, 4].map((beat) => note(`s1.v1.bar1.beat${beat}`, 'C5')),
      note('s1.v2.bar1.beat1', 'E4'),
      note('s2.bar1.beat1', 'C3'),
      { type: 'clef.set', target: 's2.bar2', payload: { clef: 'treble' } },
    ]);
    const pages = renderScoreToSvg(score);
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0]!.svg).toContain('<svg');
  });
});
