import { fullBandChart, grandStaffChart, nastyChart, twoVoiceChart } from '@sibei/fixtures';
import { describe, expect, it } from 'vitest';
import {
  addPartOp,
  addStaffOp,
  addVoiceOp,
  instrumentOp,
  newItemOp,
  partRows,
  removePartOp,
  removeStaffOp,
  removeVoiceOp,
  seedPitchFor,
  setClefOp,
  voiceForKey,
} from '@sibei/ui';

/**
 * The staves-and-voices panel's ops (ADR-0041, slice 5b): addressed the way the CLI addresses them, with `force` only
 * after the reader confirmed, and the voice keys bound only to voices the active staff has.
 */

describe('partRows', () => {
  it('numbers staves across the score and notes which hold music', () => {
    const rows = partRows(grandStaffChart());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.staves.map((staff) => [staff.number, staff.clef])).toEqual([
      [1, 'treble'],
      [2, 'bass'],
    ]);
    expect(rows[0]!.holdsNotation).toBe(true);
  });

  it('counts staves across parts in order', () => {
    const rows = partRows(fullBandChart());
    const numbers = rows.flatMap((part) => part.staves.map((staff) => staff.number));
    expect(numbers).toEqual(numbers.map((_, at) => at + 1));
    expect(rows.length).toBeGreaterThan(1);
  });

  it('lists the voices of a staff, and a lead sheet has the one staff with voice 1', () => {
    expect(partRows(twoVoiceChart())[0]!.staves[0]!.voices.map((voice) => voice.index)).toEqual([1, 2]);
    const lead = partRows(nastyChart());
    expect(lead).toHaveLength(1);
    expect(lead[0]!.staves).toHaveLength(1);
    expect(lead[0]!.staves[0]!.voices.map((voice) => voice.index)).toEqual([1]);
  });
});

describe('the ops', () => {
  const grand = partRows(grandStaffChart())[0]!;
  const lower = grand.staves[1]!;

  it('addresses parts, staves and voices as the CLI does', () => {
    expect(addStaffOp(grand, 'alto', 'standard')).toEqual({ type: 'staff.add', target: 'p1', payload: { clef: 'alto', type: 'standard' } });
    expect(addVoiceOp(lower)).toEqual({ type: 'voice.add', target: 's2' });
    expect(setClefOp(lower, 'tenor')).toEqual({ type: 'clef.set', target: 's2', payload: { clef: 'tenor' } });
    expect(setClefOp(lower, 'treble', 5)).toEqual({ type: 'clef.set', target: 's2.bar5', payload: { clef: 'treble' } });
    expect(setClefOp(lower, null, 5)).toEqual({ type: 'clef.set', target: 's2.bar5', payload: { clef: null } });
    expect(addPartOp('  Bass  ', 'bass', 'standard')).toEqual({ type: 'part.add', payload: { name: 'Bass', clef: 'bass', staffType: 'standard' } });
    expect(addPartOp('', 'treble', 'standard')).toEqual({ type: 'part.add', payload: { clef: 'treble', staffType: 'standard' } });
  });

  it('sends force only when asked to', () => {
    expect(removeStaffOp(lower, false)).toEqual({ type: 'staff.rm', target: 's2' });
    expect(removeStaffOp(lower, true)).toEqual({ type: 'staff.rm', target: 's2', payload: { force: true } });
    expect(removeVoiceOp(lower, 2, true)).toEqual({ type: 'voice.rm', target: 's2.v2', payload: { force: true } });
    expect(removePartOp(grand, false)).toEqual({ type: 'part.rm', target: 'p1' });
  });
});

describe('instrumentOp', () => {
  const part = partRows(grandStaffChart())[0]!;
  const seed = { name: part.name, program: part.instrument === null ? '' : String(part.instrument), transposition: String(part.transposition) };

  it('sends nothing when nothing changed', () => {
    expect(instrumentOp(part, seed)).toEqual({ ok: true, error: null, op: null });
  });

  it('sends only the fields that changed', () => {
    const parsed = instrumentOp(part, { ...seed, name: 'Clarinet', transposition: '-2' });
    expect(parsed.op).toEqual({ type: 'instrument.set', target: 'p1', payload: { name: 'Clarinet', transposition: -2 } });
  });

  it('refuses a program or transposition the server would', () => {
    expect(instrumentOp(part, { ...seed, program: '200' }).ok).toBe(false);
    expect(instrumentOp(part, { ...seed, program: '1.5' }).ok).toBe(false);
    expect(instrumentOp(part, { ...seed, transposition: '99' }).ok).toBe(false);
    expect(instrumentOp(part, { ...seed, transposition: 'x' }).ok).toBe(false);
  });

  it('blank program is none', () => {
    const withProgram = { ...part, instrument: 5 };
    expect(instrumentOp(withProgram, { name: withProgram.name, program: '', transposition: String(withProgram.transposition) }).op).toEqual({
      type: 'instrument.set',
      target: 'p1',
      payload: { instrument: null },
    });
  });
});

describe('newItemOp', () => {
  it('carries the staff and voice qualifier it is given', () => {
    expect(newItemOp('s2.v2.', 3, { kind: 'note', beat: 2.5, pitch: 'E3', duration: { value: 8, dots: 0 } })).toEqual({
      type: 'note.add',
      target: 's2.v2.bar3.beat2.5',
      payload: { pitch: 'E3', duration: { value: 8, dots: 0 } },
    });
    expect(newItemOp('', 1, { kind: 'rest', beat: 1, pitch: '', duration: { value: 4, dots: 0 } })).toEqual({
      type: 'rest.add',
      target: 'bar1.beat1',
      payload: { duration: { value: 4, dots: 0 } },
    });
  });

  it('seeds a pitch that sits on the staff for each clef', () => {
    expect(seedPitchFor('bass')).toBe('D3');
    expect(seedPitchFor('treble')).toBe('B4');
  });
});

describe('voiceForKey', () => {
  it('selects only a voice the active staff has', () => {
    const score = twoVoiceChart();
    expect(voiceForKey(score, { staff: 1, voice: 1 }, '2')).toBe(2);
    expect(voiceForKey(score, { staff: 1, voice: 1 }, '3')).toBeNull();
    expect(voiceForKey(score, { staff: 1, voice: 1 }, 'a')).toBeNull();
    expect(voiceForKey(score, { staff: 7, voice: 1 }, '1')).toBeNull();
  });
});
