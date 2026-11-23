import { describe, expect, it } from 'vitest';
import { applyOperation, OperationError, replay } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { layout } from '@sibei/layout';
import { INSTRUMENT_PRESETS, allStaves, planSetup, projectScore } from '@sibei/model';
import type { Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';
import { INSTRUMENT_CHOICES, instrumentList, newChartOps, problemWith } from '../../packages/ui/src/lib/new-chart.js';

/** A chart started from instrument presets (SIB2-272, SIB2-288): the applier, the replay guarantee, the CLI's and the picker's shapes. */

const create = (instruments?: string[]): Operation =>
  ({ type: 'score.create', payload: { id: 'x', title: 'X', barCount: 4, ...(instruments === undefined ? {} : { instruments }) } }) as Operation;

function made(instruments?: string[]): { score: Score; recorded: Operation } {
  const applied = applyOperation(null, create(instruments));
  return { score: applied.score, recorded: applied.operation };
}

describe('score.create with instruments', () => {
  it('a piano is one part with a treble and a bass staff, named, scored by width', () => {
    const { score } = made(['piano']);
    expect(score.parts).toHaveLength(1);
    expect(score.parts[0]).toMatchObject({ id: 'part-1', name: 'Piano', shortName: 'Pno.', instrument: 0, transposition: 0 });
    expect(score.parts[0]!.staves.map((staff) => [staff.id, staff.type, staff.clef])).toEqual([
      ['staff-1', 'standard', 'treble'],
      ['staff-2', 'standard', 'bass'],
    ]);
    // Every staff has an empty voice in every bar of the grid.
    expect(score.parts[0]!.staves.every((staff) => staff.bars.length === 4)).toBe(true);
    expect(score.meta.layout).toBe('score');
    expect(score.meta.showInstrumentNames).toBe(true);
    // The brace and the name are drawn.
    const first = layout(score).pages[0]!.systems[0]!;
    expect(first.groups?.map((group) => group.kind)).toEqual(['brace']);
    expect(first.names?.map((name) => name.text)).toEqual(['Piano']);
  });

  it('sets the transposition, program and clef of the horns, bass and kit', () => {
    const { score } = made(['trumpet-bb', 'alto-sax-eb', 'tenor-sax-bb', 'bass', 'drums']);
    expect(score.parts.map((part) => [part.name, part.transposition, part.instrument])).toEqual([
      ['Trumpet in Bb', 2, 56],
      ['Alto Sax in Eb', 9, 65],
      ['Tenor Sax in Bb', 14, 66],
      ['Bass', 0, 32],
      ['Drum Kit', 0, null],
    ]);
    const staves = allStaves(score);
    expect(staves.map((staff) => [staff.type, staff.clef])).toEqual([
      ['standard', 'treble'],
      ['standard', 'treble'],
      ['standard', 'treble'],
      ['standard', 'bass'],
      ['percussion', 'percussion'],
    ]);
    expect(staves.map((staff) => staff.id)).toEqual(['staff-1', 'staff-2', 'staff-3', 'staff-4', 'staff-5']);
    // It renders, whole.
    expect(renderScoreToSvg(score)[0]!.svg).toContain('Tenor Sax in Bb');
  });

  it('a create without instruments, or with an empty list, is the unchanged lead sheet', () => {
    const plain = made().score;
    expect(made([]).score).toEqual(plain);
    expect(plain.parts).toHaveLength(1);
    expect(plain.meta.layout).toBeUndefined();
    expect(plain.meta.showInstrumentNames).toBeUndefined();
    // The lead-sheet preset has no name, so no names and no layout change either.
    const lead = made(['lead-sheet']).score;
    expect(lead.meta.showInstrumentNames).toBeUndefined();
    expect(lead.meta.layout).toBeUndefined();
  });

  it('refuses an unknown preset naming the known ones, and too many', () => {
    expect(() => made(['banjo'])).toThrow(/unknown instrument "banjo".*piano/);
    expect(() => made(new Array(17).fill('bass') as string[])).toThrow(OperationError);
  });

  it('records the parts, so replay never reads the catalogue again', () => {
    const { score, recorded } = made(['piano', 'bass']);
    const payload = (recorded as { payload: { parts?: unknown } }).payload;
    expect(payload.parts).toHaveLength(2);
    expect(replay([recorded])).toEqual(score);
    // An old log whose recorded parts differ from today's catalogue still builds what it recorded.
    const edited = { ...recorded, payload: { ...(recorded as { payload: object }).payload, parts: [{ id: 'part-1', name: 'Old', instrument: null, transposition: 0, staves: [{ id: 'staff-1', type: 'standard', clef: 'bass' }] }] } } as Operation;
    expect(replay([edited])!.parts[0]).toMatchObject({ name: 'Old' });
  });

  it('shows in the text projection', () => {
    const text = projectScore(made(['trumpet-bb', 'piano']).score);
    expect(text).toContain('part p1 "Trumpet in Bb" short "Tpt." gm56 transposition +2');
    expect(text).toContain('layout: score');
  });
});

describe('the catalogue', () => {
  it('names every preset the brief asks for, each once', () => {
    expect(INSTRUMENT_PRESETS.map((preset) => preset.id)).toEqual([
      'lead-sheet', 'piano', 'voice', 'guitar', 'bass', 'drums', 'trumpet-bb', 'alto-sax-eb', 'tenor-sax-bb', 'flute', 'violin', 'cello',
    ]);
    expect(planSetup(['piano', 'nope'])).toEqual({ ok: false, unknown: 'nope' });
  });
});

describe('the browser picker', () => {
  it('offers the model catalogue', () => {
    expect(INSTRUMENT_CHOICES.map((choice) => choice.id)).toEqual(INSTRUMENT_PRESETS.map((preset) => preset.id));
    expect(INSTRUMENT_CHOICES[0]).toEqual({ id: 'lead-sheet', label: 'Lead sheet' });
  });

  it('adds, changes, moves and removes rows', () => {
    let list: string[] = [];
    list = instrumentList.add(list);
    list = instrumentList.add(list);
    expect(list).toEqual(['piano', 'bass']);
    list = instrumentList.change(list, 1, 'drums');
    list = instrumentList.move(list, 1, -1);
    expect(list).toEqual(['drums', 'piano']);
    expect(instrumentList.move(list, 0, -1)).toEqual(['drums', 'piano']);
    expect(instrumentList.remove(list, 0)).toEqual(['piano']);
  });

  it('sends the same score.create the CLI does, and nothing when the list is empty', () => {
    const base = { title: 'T', key: 'C', time: '4/4', bars: 8, pickup: false };
    const withList = newChartOps({ ...base, instruments: ['piano', 'bass'] }, 't-1')[0] as { payload: { instruments?: string[] } };
    expect(withList.payload.instruments).toEqual(['piano', 'bass']);
    expect(Object.keys((newChartOps({ ...base, instruments: [] }, 't-1')[0] as { payload: object }).payload)).not.toContain('instruments');
    expect(problemWith({ ...base, instruments: new Array(17).fill('bass') as string[] })).toMatch(/at most 16/);
    // Both surfaces build the very same score.
    const fromBrowser = applyOperation(null, newChartOps({ ...base, instruments: ['piano', 'bass'] }, 't-1')[0] as Operation).score;
    const fromCli = applyOperation(null, { type: 'score.create', payload: { id: 't-1', title: 'T', barCount: 8, instruments: ['piano', 'bass'], key: { tonic: 'C', alter: 0, mode: 'major' }, time: { beats: 4, beatValue: 4 } } }).score;
    expect(fromBrowser).toEqual(fromCli);
  });
});
