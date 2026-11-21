import { describe, expect, it } from 'vitest';
import { aabaChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import type { Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';
import { renderScorePages } from '@sibei/ui';

/** A section's name is boxed beside its letter (SIB2-176). */

const named = (patch: { letter: string | null; name: string | null }): Score => {
  const base = aabaChart();
  return {
    ...base,
    sections: base.sections.map((section, index) => (index === 0 ? { ...section, ...patch } : section)),
  };
};

const count = (score: Score, cls: string): number =>
  (renderScoreToSvg(score).map((p) => p.svg).join('').match(new RegExp(`class="${cls}"`, 'g')) ?? []).length;

describe('section name box', () => {
  it('draws a name box beside the letter box, and only for named sections', () => {
    const plain = aabaChart();
    const baseline = count(plain, 'se-sectionnamebox');
    const both = named({ letter: 'A', name: 'HEAD' });
    expect(count(both, 'se-sectionnamebox')).toBe(baseline + 1);
    expect(count(both, 'se-rehearsalbox')).toBe(count(plain, 'se-rehearsalbox'));
  });

  it('draws a name on its own when the section has no letter', () => {
    const nameOnly = named({ letter: null, name: 'Intro' });
    expect(count(nameOnly, 'se-sectionnamebox')).toBe(count(aabaChart(), 'se-sectionnamebox') + 1);
    expect(count(nameOnly, 'se-rehearsalbox')).toBe(count(aabaChart(), 'se-rehearsalbox') - 1);
    const items = layout(nameOnly).pages.flatMap((p) => p.systems.flatMap((s) => s.bars.flatMap((b) => b.items)));
    expect(items.some((i) => i.kind === 'rehearsalMark' && i.text === '' && i.name === 'Intro')).toBe(true);
  });

  it('draws the same bytes in the browser and on the server', () => {
    const score = named({ letter: 'A', name: 'HEAD' });
    expect(renderScorePages(score).map((p) => p.svg)).toEqual(renderScoreToSvg(score).map((p) => p.svg));
  });
});
