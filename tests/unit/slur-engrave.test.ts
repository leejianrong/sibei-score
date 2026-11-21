import { describe, expect, it } from 'vitest';
import { slurChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import { renderScoreToSvg } from '@sibei/pdf';
import { slurSide } from '../../packages/engrave/src/slurs.js';

/** SIB2-168: slurs are laid out per system (halves across a break) and drawn on the notehead side. */

describe('slur layout', () => {
  const result = layout(slurChart());
  const systems = result.pages.flatMap((page) => page.systems);

  it('keeps a slur inside its system, and splits one that crosses a system break into two halves', () => {
    expect(systems).toHaveLength(2);
    const [first, second] = systems;
    expect(first?.slurs.map((s) => s.id)).toEqual(['slur-1', 'slur-2', 'slur-3', 'slur-4']);
    // slur-4 runs from bar 4 (line 1) to bar 5 (line 2).
    expect(first?.slurs[3]).toMatchObject({ id: 'slur-4', toNoteId: null });
    expect(first?.slurs[3]?.fromNoteId).not.toBeNull();
    expect(second?.slurs[0]).toMatchObject({ id: 'slur-4', fromNoteId: null });
    expect(second?.slurs[0]?.toNoteId).not.toBeNull();
    expect(second?.slurs.map((s) => s.id)).toEqual(['slur-4', 'slur-5', 'slur-6', 'slur-7']);
    expect(second?.slurs.find((s) => s.id === 'slur-6')?.placement).toBe('below');
  });

  it('draws one path per slur, halves included', () => {
    const svg = renderScoreToSvg(slurChart())
      .map((page) => page.svg)
      .join('');
    expect(svg.match(/class="se-slur"/g)).toHaveLength(8);
  });
});

describe('slur side', () => {
  const end = (stem: 'up' | 'down' | null) => ({ x: 0, noteheadWidth: 10, y: 0, stem });
  it('goes on the notehead side, above when the stems are mixed or absent', () => {
    expect(slurSide({ under: [end('down'), end('down')], placement: undefined })).toBe('above');
    expect(slurSide({ under: [end('up'), end('up'), end('down')], placement: undefined })).toBe('below');
    expect(slurSide({ under: [end('up'), end('down')], placement: undefined })).toBe('above');
    expect(slurSide({ under: [end(null)], placement: undefined })).toBe('above');
  });
  it('obeys a chosen placement', () => {
    expect(slurSide({ under: [end('down')], placement: 'below' })).toBe('below');
  });
});
