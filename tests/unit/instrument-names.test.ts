import { describe, expect, it } from 'vitest';
import { applyOperation } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { engravePage } from '@sibei/engrave';
import { FIXTURE_REGISTRY, instrumentNamesChart, leadBassChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import { projectScore } from '@sibei/model';
import type { Score } from '@sibei/model';

/** Instrument names on the system (SIB2-286): off by default and byte-identical, then full / short, the ops and MusicXML. */

function run(operations: Operation[]): Score {
  let score: Score | null = null;
  for (const operation of operations) score = applyOperation(score, operation).score;
  return score!;
}

const without = (score: Score): Score => {
  const { showInstrumentNames: _on, ...meta } = score.meta;
  return { ...score, meta };
};

describe('layout', () => {
  it('draws no names and reserves no room unless the score asks', () => {
    const chart = leadBassChart();
    expect(chart.parts.some((part) => part.name !== '')).toBe(true);
    const plain = layout(chart);
    const shown = layout({ ...chart, meta: { ...chart.meta, showInstrumentNames: true } });
    expect(plain.pages.flatMap((page) => page.systems).every((system) => system.names === undefined)).toBe(true);
    expect(layout(without(instrumentNamesChart()))).toEqual(layout(without(instrumentNamesChart())));
    expect(shown.pages[0]!.systems[0]!.x).toBeGreaterThan(plain.pages[0]!.systems[0]!.x);
  });

  it('prints the full name on the first system and the short name after', () => {
    const systems = layout(instrumentNamesChart()).pages.flatMap((page) => page.systems);
    expect(systems.length).toBeGreaterThan(1);
    expect(systems[0]!.names!.map((n) => n.text)).toEqual(['Trumpet in Bb', 'Piano', 'Electric Bass', 'Drum Kit']);
    expect(systems[1]!.names!.map((n) => n.text)).toEqual(['Tpt.', 'Pno.', 'Bass', 'Dr.']);
    // The first system is narrower than a later one, by the longer names.
    expect(systems[0]!.x).toBeGreaterThan(systems[1]!.x);
    // The piano's name is centred on its two staves.
    expect(systems[0]!.names![1]).toMatchObject({ firstStaff: 1, lastStaff: 2 });
  });

  it('keeps a later system clear when a part has no short name', () => {
    const chart = instrumentNamesChart();
    const bare: Score = { ...chart, parts: chart.parts.map(({ shortName: _s, ...part }) => part) };
    const systems = layout(bare).pages.flatMap((page) => page.systems);
    expect(systems[1]!.names).toBeUndefined();
  });

  it('engraves the names as text, and nothing when they are off', () => {
    const page = (score: Score): string => engravePage(layout(score), 0).svg;
    expect(page(instrumentNamesChart())).toContain('se-instrument-name');
    expect(page(instrumentNamesChart())).toContain('Trumpet in Bb');
    expect(page(without(instrumentNamesChart()))).not.toContain('se-instrument-name');
  });

  it('is registered as a fixture', () => {
    expect(FIXTURE_REGISTRY['instrument-names']).toBe(instrumentNamesChart);
  });
});

describe('ops', () => {
  const create: Operation = { type: 'score.create', payload: { id: 'x', title: 'X', barCount: 4 } } as Operation;

  it('instrument.set sets and clears the short name', () => {
    const named = run([create, { type: 'instrument.set', payload: { name: 'Piano', shortName: 'Pno.' } }]);
    expect(named.parts[0]).toMatchObject({ name: 'Piano', shortName: 'Pno.' });
    const cleared = run([create, { type: 'instrument.set', payload: { shortName: 'Pno.' } }, { type: 'instrument.set', payload: { shortName: null } }]);
    expect('shortName' in cleared.parts[0]!).toBe(false);
  });

  it('meta.set turns the names on and off, storing off as absent', () => {
    const on = run([create, { type: 'meta.set', payload: { showInstrumentNames: true } }]);
    expect(on.meta.showInstrumentNames).toBe(true);
    const off = run([create, { type: 'meta.set', payload: { showInstrumentNames: true } }, { type: 'meta.set', payload: { showInstrumentNames: false } }]);
    expect('showInstrumentNames' in off.meta).toBe(false);
    expect(() => run([create, { type: 'meta.set', payload: { showInstrumentNames: 'yes' as unknown as boolean } }])).toThrow(/true or false/);
  });

  it('shows in the text projection', () => {
    const text = projectScore(instrumentNamesChart());
    expect(text).toContain('instrument names: shown');
    expect(text).toContain('short "Tpt."');
  });
});

describe('MusicXML', () => {
  it('round-trips the part name and abbreviation', () => {
    const xml = scoreToMusicXml(instrumentNamesChart());
    expect(xml).toContain('<part-abbreviation>Tpt.</part-abbreviation>');
    const { score } = musicXmlToScore(xml, { id: 'rt' });
    expect(score.parts.map((part) => [part.name, part.shortName])).toEqual([
      ['Trumpet in Bb', 'Tpt.'],
      ['Piano', 'Pno.'],
      ['Electric Bass', 'Bass'],
      ['Drum Kit', 'Dr.'],
    ]);
  });
});
