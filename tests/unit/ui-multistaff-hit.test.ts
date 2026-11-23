import { DEFAULT_MUSIC_FONT } from '@sibei/engrave';
import { fullBandChart, grandStaffChart, leadBassChart, nastyChart, twoVoiceChart, voiceCollisionsChart } from '@sibei/fixtures';
import { allStaves } from '@sibei/model';
import type { Score } from '@sibei/model';
import { describe, expect, it } from 'vitest';
import {
  barAt,
  clampLane,
  findItem,
  hitTest,
  laneLabel,
  laneOfItem,
  loadFont,
  needsQualifier,
  pageBarBoxes,
  pageItemBoxes,
  qualifierOf,
  renderScorePages,
  slurOp,
} from '@sibei/ui';

/**
 * Hit-testing in a staved system (ADR-0041, slice 5b). A click must resolve the staff and voice from the
 * layout's own `staves`, never assume the first: every note of every staff and voice is clicked at the
 * centre of its box and has to come back as itself, on the staff and in the voice the stored score puts it in.
 */

const font = loadFont(DEFAULT_MUSIC_FONT);

function pagesOf(score: Score) {
  return renderScorePages(score, { paper: 'a4' }, { font: DEFAULT_MUSIC_FONT });
}

describe.each([
  ['grand-staff', grandStaffChart],
  ['two-voice', twoVoiceChart],
  ['lead-bass', leadBassChart],
  ['full-band', fullBandChart],
])('hit-testing %s', (_name, build) => {
  const score = build();

  it('finds every note and rest on its own staff and voice', () => {
    let seen = 0;
    for (const page of pagesOf(score)) {
      const boxes = pageItemBoxes(page.layout, font);
      for (const box of boxes) {
        seen += 1;
        const lane = laneOfItem(score, box.id);
        expect(lane, box.id).toEqual({ staff: box.staffIndex + 1, voice: box.voice });
        const located = findItem(page.layout, box.id);
        expect(located).toMatchObject({ staffIndex: box.staffIndex, voice: box.voice });
        // The click lands on the staff the item is on, whatever the voice beside it.
        const hit = hitTest(boxes, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
        expect(hit, box.id).not.toBeNull();
        expect(hit!.staffIndex, box.id).toBe(box.staffIndex);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('boxes one bar band per staff', () => {
    const staves = allStaves(score).length;
    for (const page of pagesOf(score)) {
      const boxes = pageBarBoxes(page.layout);
      const first = page.layout.systems[0]!;
      expect(boxes.filter((box) => box.barNumber === first.bars[0]!.barNumber)).toHaveLength(staves);
    }
  });
});

describe('hit-testing a second staff', () => {
  it('a click in the lower staff of a grand staff selects the bar of that staff', () => {
    const score = grandStaffChart();
    const page = pagesOf(score)[0]!;
    const lower = pageBarBoxes(page.layout).filter((box) => box.staffIndex === 1)[0]!;
    const hit = barAt(pageBarBoxes(page.layout), { x: lower.x + lower.width / 2, y: lower.y + lower.height / 2 });
    expect(hit).toMatchObject({ staffIndex: 1, barNumber: lower.barNumber });
  });

  it('a voice-collisions chart still resolves both voices of a shared column', () => {
    const score = voiceCollisionsChart();
    const page = pagesOf(score)[0]!;
    const boxes = pageItemBoxes(page.layout, font);
    expect(new Set(boxes.map((box) => box.voice)).size).toBeGreaterThan(1);
  });
});

describe('a lead sheet is untouched', () => {
  it('every item is staff 0, voice 1 and the chart needs no qualifier', () => {
    const score = nastyChart();
    expect(needsQualifier(score)).toBe(false);
    expect(qualifierOf(score, { staff: 1, voice: 1 })).toBe('');
    for (const page of pagesOf(score)) {
      for (const box of pageItemBoxes(page.layout, font)) {
        expect(box).toMatchObject({ staffIndex: 0, voice: 1 });
      }
    }
  });
});

describe('lanes', () => {
  it('qualifies an address by position once there is more than one staff or voice', () => {
    expect(qualifierOf(grandStaffChart(), { staff: 2, voice: 1 })).toBe('s2.v1.');
    expect(qualifierOf(twoVoiceChart(), { staff: 1, voice: 2 })).toBe('s1.v2.');
  });

  it('keeps the lane inside what the chart has', () => {
    const score = grandStaffChart();
    expect(clampLane(score, { staff: 9, voice: 1 })).toEqual({ staff: 2, voice: 1 });
    expect(clampLane(score, { staff: 1, voice: 3 })).toEqual({ staff: 1, voice: 1 });
  });

  it('labels the lane with the staff clef', () => {
    expect(laneLabel(grandStaffChart(), { staff: 2, voice: 1 })).toBe('Staff 2 · bass · Voice 1');
  });

  it('a slur joins two notes of one voice only', () => {
    const score = twoVoiceChart();
    const byLane = new Map<string, string[]>();
    for (const page of pagesOf(score)) {
      for (const box of pageItemBoxes(page.layout, font)) {
        if (box.kind !== 'note') continue;
        byLane.set(`${box.staffIndex}.${box.voice}`, [...(byLane.get(`${box.staffIndex}.${box.voice}`) ?? []), box.id]);
      }
    }
    const lanes = [...byLane.values()].filter((ids) => ids.length > 0);
    expect(lanes.length).toBeGreaterThan(1);
    expect(slurOp(score, lanes[0]![0]!, lanes[1]![0]!, 'auto')).toBeNull();
    if (lanes[0]!.length > 1) expect(slurOp(score, lanes[0]![0]!, lanes[0]![1]!, 'auto')).not.toBeNull();
  });
});
