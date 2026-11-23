import {
  FIXTURE_REGISTRY,
  BarBuilder,
  fullBandChart,
  grandStaffChart,
  leadBassChart,
  twoVoiceChart,
} from '@sibei/fixtures';
import type { LayoutResult, LayoutSystem } from '@sibei/layout';
import { INK_CLEARANCE, STAFF_GAP, isMultiLane, layout } from '@sibei/layout';
import type { Score } from '@sibei/model';
import { createIdFactory, dur, makeStaffedScore, voiceOfView } from '@sibei/model';
import { describe, expect, it } from 'vitest';

/**
 * SIB2-227: layout time-alignment across staves and voices. The hard rule is the first block: a chart with one staff
 * and one voice lays out exactly as before (the existing layout tests and every committed snapshot hold that too).
 */

const MULTI: Record<string, () => Score> = {
  'grand-staff': grandStaffChart,
  'two-voice': twoVoiceChart,
  'lead-bass': leadBassChart,
  'full-band': fullBandChart,
};

const systemsOf = (result: LayoutResult): LayoutSystem[] => result.pages.flatMap((page) => page.systems);

describe('a single-staff single-voice chart lays out as it always has', () => {
  const singles = Object.entries(FIXTURE_REGISTRY).filter(([, build]) => !isMultiLane(build()));

  it('has single-staff fixtures to hold', () => {
    expect(singles.length).toBeGreaterThan(10);
  });

  it.each(singles)('%s carries none of the multi-staff fields', (_name, build) => {
    const json = JSON.stringify(layout(build()));
    for (const field of ['"staves"', '"groups"', '"staffSpan"', '"alignment"', '"columns"']) {
      expect(json).not.toContain(field);
    }
    // No item carries an x (the adapter spaces the bar's notes), and no clef other than treble appears.
    expect(json).not.toMatch(/"kind":"(note|rest|chordSymbol|annotation)"[^{}]*"x":/);
    expect(json).not.toMatch(/"kind":"clef","clef":"(?!treble)/);
  });

  it.each(singles)('%s is the same with `meta.layout` set to the lead-sheet default', (_name, build) => {
    const score = build();
    const explicit: Score = { ...score, meta: { ...score.meta, layout: 'lead-sheet' } };
    expect(layout(explicit)).toEqual(layout(score));
  });
});

describe('onsets align across every staff and voice', () => {
  for (const [name, build] of Object.entries(MULTI)) {
    it(`${name}: simultaneous items in a bar share one x`, () => {
      const result = layout(build());
      let compared = 0;
      for (const system of systemsOf(result)) {
        for (const [barIndex, bar] of system.bars.entries()) {
          const byOnset = new Map<number, Set<number>>();
          for (const staff of system.staves ?? []) {
            for (const voice of staff.bars[barIndex]?.voices ?? []) {
              for (const item of voice.items) {
                if (item.kind !== 'note' && item.kind !== 'rest') continue;
                expect(item.x, `${name} bar ${bar.barNumber} item has no x`).toBeDefined();
                const set = byOnset.get(item.onset) ?? new Set<number>();
                set.add(item.x!);
                byOnset.set(item.onset, set);
                compared += 1;
              }
            }
          }
          for (const [onset, xs] of byOnset) expect([...xs], `bar ${bar.barNumber} onset ${onset}`).toHaveLength(1);
          // Columns run left to right inside the bar's music box.
          const columns = bar.alignment?.columns ?? [];
          columns.forEach((column, index) => {
            if (index > 0) expect(column.x).toBeGreaterThan(columns[index - 1]!.x);
            expect(column.x).toBeGreaterThanOrEqual(bar.x + bar.prefixWidth);
            expect(column.x).toBeLessThanOrEqual(bar.x + bar.width);
          });
          // A chord on a note's onset sits on that note's column.
          for (const item of bar.items) {
            if (item.kind !== 'chordSymbol') continue;
            const column = columns.find((candidate) => candidate.onset === item.onset);
            if (column !== undefined) expect(item.x).toBe(column.x);
          }
        }
      }
      expect(compared).toBeGreaterThan(20);
    });
  }

  it('puts a left-hand note under the right-hand note it coincides with, and between the ones it does not', () => {
    const system = systemsOf(layout(grandStaffChart()))[0]!;
    const [right, left] = system.staves!;
    const bar = 0;
    const rightXs = right!.bars[bar]!.voices[0]!.items.filter((item) => item.kind === 'note').map((item) => (item as { x: number }).x);
    const leftXs = left!.bars[bar]!.voices[0]!.items.filter((item) => item.kind === 'note').map((item) => (item as { x: number }).x);
    // Bar 1: eighths against quarters/halves; the left hand's onsets are a subset of the right hand's columns.
    for (const x of leftXs) expect(rightXs).toContain(x);
    expect(rightXs.length).toBeGreaterThan(leftXs.length);
  });

  it('is deterministic: the same score gives the same layout', () => {
    for (const build of Object.values(MULTI)) expect(layout(build())).toEqual(layout(build()));
  });

  it('lays a rest in one voice on the column of the other voice\'s note', () => {
    const system = systemsOf(layout(twoVoiceChart()))[0]!;
    const bar = 2; // voice 2 rests for the first half of bar 3
    const staff = system.staves![0]!;
    const [upper, lower] = staff.bars[bar]!.voices;
    const rest = lower!.items.find((item) => item.kind === 'rest') as { x: number; onset: number };
    const note = upper!.items.find((item) => item.kind === 'note' && item.onset === rest.onset) as { x: number };
    expect(rest.x).toBe(note.x);
    expect([upper!.stems, lower!.stems]).toEqual(['up', 'down']);
  });
});

describe('a bar is as wide as its widest staff', () => {
  const ids = createIdFactory();
  const make = (number: number): BarBuilder => new BarBuilder(ids, { number });
  const dense = (n: number): BarBuilder => {
    const b = make(n);
    for (let i = 0; i < 16; i += 1) b.note(i % 2 === 0 ? 'F#5' : 'G#5', dur(16));
    return b;
  };
  const sparse = (n: number): BarBuilder => make(n).note('C3', dur(1));
  const light = (n: number): BarBuilder => make(n).note('C5', dur(4)).note('C5', dur(4)).note('C5', dur(2));

  const bars = (write: (n: number) => BarBuilder, count: number) =>
    Array.from({ length: count }, (_, i) => voiceOfView(write(i + 1).build()));
  const grid = (count: number) => Array.from({ length: count }, (_, i) => light(i + 1).build());
  const widths = (score: Score): number[] => systemsOf(layout(score))[0]!.bars.map((bar) => bar.width);

  // Bar 1 is dense on one staff only, in either staff order; the other bars are light on both.
  const mixed = (n: number): BarBuilder => (n === 1 ? dense(n) : light(n));
  const rest = (n: number): BarBuilder => (n === 1 ? sparse(n) : light(n));

  it('does not depend on which staff is the dense one', () => {
    const a = makeStaffedScore({ id: 'a', bars: grid(4), parts: [{ staves: [{ bars: bars(mixed, 4) }, { clef: 'bass', bars: bars(rest, 4) }] }] });
    const b = makeStaffedScore({ id: 'b', bars: grid(4), parts: [{ staves: [{ clef: 'bass', bars: bars(rest, 4) }, { bars: bars(mixed, 4) }] }] });
    expect(widths(a)).toEqual(widths(b));
  });

  it('gives the dense bar the width the dense staff alone would get', () => {
    const solo = makeStaffedScore({ id: 's', bars: grid(4), parts: [{ staves: [{ bars: bars(mixed, 4) }] }] });
    const both = makeStaffedScore({ id: 'b', bars: grid(4), parts: [{ staves: [{ bars: bars(mixed, 4) }, { clef: 'bass', bars: bars(rest, 4) }] }] });
    // The second staff's only onset is one the dense staff already has, so it asks for nothing more.
    expect(widths(both)).toEqual(widths(solo));
    const [first, ...others] = widths(both);
    expect(first).toBeGreaterThan(Math.max(...others));
  });
});

describe('staves stack down the system', () => {
  it('places each staff by its offset, below the last, never closer than the minimum gap', () => {
    for (const build of Object.values(MULTI)) {
      for (const system of systemsOf(layout(build()))) {
        const staves = system.staves!;
        expect(staves[0]!.staveY).toBe(system.staveY);
        expect(staves[0]!.staveOffset).toBe(0);
        for (let i = 1; i < staves.length; i += 1) {
          const above = staves[i - 1]!;
          const staff = staves[i]!;
          expect(staff.staveY).toBe(system.staveY + staff.staveOffset);
          expect(staff.staveY - (above.staveY + above.height)).toBeGreaterThanOrEqual(STAFF_GAP);
        }
        const last = staves[staves.length - 1]!;
        expect(system.y + system.height).toBeCloseTo(last.staveY + last.height + system.belowStaff, 6);
      }
    }
  });

  it('opens the gap for ledger-line ink between two staves', () => {
    const ids = createIdFactory();
    const make = (n: number): BarBuilder => new BarBuilder(ids, { number: n });
    const withLeft = (pitch: string, topPitch: string): Score => {
      const right = (n: number) => voiceOfView(make(n).note(topPitch, dur(1)).build());
      const left = (n: number) => voiceOfView(make(n).note(pitch, dur(1)).build());
      return makeStaffedScore({
        id: 'ledger',
        bars: [make(1).build()],
        parts: [{ staves: [{ bars: [right(1)] }, { clef: 'bass', bars: [left(1)] }] }],
      });
    };
    const gap = (score: Score): number => {
      const [top, bottom] = systemsOf(layout(score))[0]!.staves!;
      return bottom!.staveOffset - (top!.staveOffset + top!.height);
    };
    const calm = gap(withLeft('D3', 'D5'));
    expect(calm).toBe(STAFF_GAP);
    // A bass note far above its staff (C5, many ledger lines) and a treble note far below its own meet in the middle.
    const crowded = gap(withLeft('C5', 'C4'));
    expect(crowded).toBeGreaterThan(STAFF_GAP);
    expect(crowded).toBeGreaterThanOrEqual(INK_CLEARANCE);
  });

  it('keeps the chord row above the top staff only', () => {
    const lone = systemsOf(layout(leadBassChart()))[0]!;
    expect(lone.chordBaselineOffset).toBeGreaterThan(0);
    expect(lone.aboveStaff).toBeGreaterThanOrEqual(lone.chordBaselineOffset);
    // The bass staff sits one staff gap under the lead, with no chord row of its own between them.
    const [top, bass] = lone.staves!;
    expect(bass!.staveOffset - top!.height).toBeLessThan(lone.aboveStaff + STAFF_GAP);
    expect(lone.bars.some((bar) => bar.items.some((item) => item.kind === 'chordSymbol'))).toBe(true);
    for (const bar of bass!.bars) {
      for (const voice of bar.voices) expect(voice.items.some((item) => item.kind === 'chordSymbol')).toBe(false);
    }
  });

  it('reads bass-clef ink against the bass staff, not the treble one', () => {
    // A3 is the top line of a bass staff: no ink above it. In treble it would be ledger lines below the staff.
    const ids = createIdFactory();
    const make = (n: number): BarBuilder => new BarBuilder(ids, { number: n });
    const score = makeStaffedScore({
      id: 'clef',
      bars: [make(1).build()],
      parts: [{ staves: [{ bars: [voiceOfView(make(1).note('C5', dur(1)).build())] }, { clef: 'bass', bars: [voiceOfView(make(1).note('G2', dur(1)).build())] }] }],
    });
    const staff = systemsOf(layout(score))[0]!.staves![1]!;
    // G2 is the bottom line of the bass staff: only the notehead reaches below it.
    expect(staff.inkBelow).toBeLessThanOrEqual(10);
  });
});

describe('groups and the barline span', () => {
  const bounds = (system: LayoutSystem, first: number, last: number): { y: number; height: number } => {
    const staves = system.staves!;
    const y = staves[first]!.staveY;
    return { y, height: staves[last]!.staveY + staves[last]!.height - y };
  };

  it('braces one part\'s staves (a grand staff) and brackets nothing', () => {
    const system = systemsOf(layout(grandStaffChart()))[0]!;
    expect(system.groups!.map((group) => [group.kind, group.firstStaff, group.lastStaff])).toEqual([['brace', 0, 1]]);
    const brace = system.groups![0]!;
    expect(brace).toMatchObject(bounds(system, 0, 1));
    expect(brace.x + brace.width).toBeLessThan(system.x);
  });

  it('brackets several parts and braces none of them when each has one staff', () => {
    const system = systemsOf(layout(leadBassChart()))[0]!;
    expect(system.groups!.map((group) => [group.kind, group.firstStaff, group.lastStaff])).toEqual([['bracket', 0, 1]]);
  });

  it('braces the piano inside a bracket around the band, the bracket outside the brace', () => {
    const system = systemsOf(layout(fullBandChart()))[0]!;
    expect(system.groups!.map((group) => [group.kind, group.firstStaff, group.lastStaff])).toEqual([
      ['brace', 1, 2],
      ['bracket', 0, 4],
    ]);
    const [brace, bracket] = system.groups!;
    expect(brace).toMatchObject(bounds(system, 1, 2));
    expect(bracket).toMatchObject(bounds(system, 0, 4));
    expect(bracket!.x + bracket!.width).toBeLessThanOrEqual(brace!.x);
    expect(system.staffSpan).toMatchObject({ firstStaff: 0, lastStaff: 4, ...bounds(system, 0, 4) });
  });

  it('has no groups on one staff of several voices', () => {
    const system = systemsOf(layout(twoVoiceChart()))[0]!;
    expect(system.groups).toEqual([]);
    expect(system.staves).toHaveLength(1);
  });

  it('gives each staff its own clef, and a percussion staff no key signature', () => {
    const system = systemsOf(layout(fullBandChart()))[0]!;
    const head = (index: number) => system.staves![index]!.bars[0]!.voices[0]!.items;
    expect(system.staves!.map((staff) => staff.clef)).toEqual(['treble', 'treble', 'bass', 'bass', 'percussion']);
    expect(head(2).find((item) => item.kind === 'clef')).toMatchObject({ clef: 'bass' });
    expect(head(4).some((item) => item.kind === 'keySignature')).toBe(false);
    expect(head(4).some((item) => item.kind === 'clef')).toBe(true);
    expect(head(1).some((item) => item.kind === 'keySignature')).toBe(true);
    // Every staff of a bar reserves the same prefix room, so the first column starts at one x.
    expect(system.bars[0]!.prefixWidth).toBeGreaterThan(0);
  });

  it('prefixes only the first system and the signature policy decides the rest', () => {
    const score = fullBandChart();
    const first: Score = { ...score, meta: { ...score.meta, signaturePolicy: 'first' } };
    const systems = systemsOf(layout(first));
    const clefs = (system: LayoutSystem): boolean[] => system.staves!.map((staff) => staff.bars[0]!.prefix.clef);
    expect(clefs(systems[0]!)).toEqual([true, true, true, true, true]);
    expect(clefs(systems[1]!)).toEqual([false, false, false, false, false]);
    // The time signature is drawn once, on the first bar, on every staff.
    expect(systems[0]!.staves!.every((staff) => staff.bars[0]!.prefix.timeSignature)).toBe(true);
    expect(systems[1]!.staves!.some((staff) => staff.bars[0]!.prefix.timeSignature)).toBe(false);
  });
});

describe('meta.layout: how a multi-staff score breaks its systems', () => {
  const barsPerSystem = (score: Score): number[] => systemsOf(layout(score)).map((system) => system.bars.length);

  it('keeps the four-bar grid by default (lead-sheet), on a multi-staff score too', () => {
    const score = fullBandChart();
    const sheet: Score = { ...score, meta: { ...score.meta, layout: 'lead-sheet' } };
    expect(barsPerSystem(sheet)).toEqual([4, 4, 4, 4]);
    const absent: Score = { ...score, meta: { ...score.meta } };
    delete absent.meta.layout;
    expect(barsPerSystem(absent)).toEqual([4, 4, 4, 4]);
  });

  it('breaks by width in score mode: more bars than a grid line when they are light, fewer when they are dense', () => {
    const counts = barsPerSystem(fullBandChart());
    expect(counts.reduce((sum, n) => sum + n, 0)).toBe(16);
    expect(counts.every((n) => n >= 1)).toBe(true);
    // Not the grid: the dense hi-hat bar costs room, so the lines are not all four.
    expect(counts).not.toEqual([4, 4, 4, 4]);
    // A line's bars fill the line: the last bar's right edge is the system's right edge.
    for (const system of systemsOf(layout(fullBandChart()))) {
      const last = system.bars[system.bars.length - 1]!;
      expect(last.x + last.width).toBeCloseTo(system.x + system.width, 6);
    }
  });

  it('applies to a single-staff chart too, and a section still breaks the line', () => {
    const base = Object.entries(FIXTURE_REGISTRY).find(([name]) => name === 'aaba-chart')![1]();
    const asScore: Score = { ...base, meta: { ...base.meta, layout: 'score' } };
    const counts = barsPerSystem(asScore);
    expect(counts.reduce((sum, n) => sum + n, 0)).toBe(base.bars.length);
    // Sections of 8 bars start on bars 1, 9, 17 and 25: no line crosses one.
    const starts = new Set([1, 9, 17, 25]);
    for (const system of systemsOf(layout(asScore))) {
      for (const bar of system.bars.filter((candidate) => !candidate.isPickup).slice(1)) {
        expect(starts.has(bar.barNumber)).toBe(false);
      }
    }
  });
});

describe('page capacity with several staves to a system', () => {
  it('breaks pages by the stacked height, and no system runs off the page', () => {
    const result = layout(fullBandChart());
    expect(result.pages.length).toBeGreaterThan(1);
    const spec = result.pageSpec;
    for (const page of result.pages) {
      let previousBottom = 0;
      for (const system of page.systems) {
        expect(system.y).toBeGreaterThanOrEqual(previousBottom);
        expect(system.y + system.height).toBeLessThanOrEqual(page.height - spec.margin.bottom + 1e-6);
        previousBottom = system.y + system.height;
      }
    }
    // Five staves are far taller than a lead sheet's one, so a page holds fewer of them.
    const lead = layout(Object.entries(FIXTURE_REGISTRY).find(([name]) => name === 'long-form')![1]());
    expect(result.pages[0]!.systems.length).toBeLessThan(lead.pages[0]!.systems.length);
  });

  it('numbers systems through the pages, and each system\'s staves sit inside it', () => {
    const systems = systemsOf(layout(fullBandChart()));
    expect(systems.map((system) => system.index)).toEqual(systems.map((_, i) => i));
    for (const system of systems) {
      for (const staff of system.staves!) {
        expect(staff.staveY).toBeGreaterThanOrEqual(system.y);
        expect(staff.staveY + staff.height).toBeLessThanOrEqual(system.y + system.height);
      }
    }
  });
});
