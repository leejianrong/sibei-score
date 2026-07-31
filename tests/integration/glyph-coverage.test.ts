import { ENGRAVED_ITEM_KINDS, styleForRole } from '@sibei/engrave';
import { everyGlyphChart, invalidBarChart, nastyChart } from '@sibei/fixtures';
import type { LayoutBarItemKind, LayoutResult } from '@sibei/layout';
import { LAYOUT_BAR_ITEM_KINDS, LAYOUT_TEXT_ROLES, layout } from '@sibei/layout';
import type { Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';
import { describe, expect, it } from 'vitest';

/**
 * The engraver handles every kind the layout contract can emit, with nothing silently
 * dropped (ADR-0014). Asserted three ways: the declared sets agree, a fixture actually
 * emits all of them, and drawing that fixture raises nothing.
 *
 * Drawing goes through `@sibei/pdf`, which is the real server path.
 */

function kindsEmittedBy(result: LayoutResult): Set<LayoutBarItemKind> {
  const kinds = new Set<LayoutBarItemKind>();
  for (const page of result.pages) {
    for (const system of page.systems) {
      for (const bar of system.bars) {
        for (const item of bar.items) kinds.add(item.kind);
      }
    }
  }
  return kinds;
}

function draw(score: Score): string[] {
  return renderScoreToSvg(score).map((page) => page.svg);
}

describe('the item-kind contract', () => {
  it('is handled in full by the adapter', () => {
    expect([...ENGRAVED_ITEM_KINDS].sort()).toEqual([...LAYOUT_BAR_ITEM_KINDS].sort());
  });

  it('lists every kind exactly once', () => {
    expect(new Set(LAYOUT_BAR_ITEM_KINDS).size).toBe(LAYOUT_BAR_ITEM_KINDS.length);
  });

  it('is exercised end to end by the every-glyph fixture', () => {
    const emitted = kindsEmittedBy(layout(everyGlyphChart()));
    const missing = LAYOUT_BAR_ITEM_KINDS.filter((kind) => !emitted.has(kind));
    expect(missing).toEqual([]);
  });

  it('draws that fixture without an unhandled kind', () => {
    const svgs = draw(everyGlyphChart());
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) expect(svg.length).toBeGreaterThan(1000);
  });
});

describe('the text-role contract', () => {
  it('has a style for every role', () => {
    for (const role of LAYOUT_TEXT_ROLES) {
      expect(styleForRole(role).family).toBeTruthy();
    }
  });

  it('emits a header only on the first page', () => {
    const result = layout(nastyChart());
    expect(result.pages[0]?.header.length).toBeGreaterThan(0);
    for (const page of result.pages.slice(1)) expect(page.header).toEqual([]);
  });
});

describe('metrically invalid bars', () => {
  it('lay out and draw as written, never rejected (ADR-0013)', () => {
    const score = invalidBarChart();
    const result = layout(score);

    const statuses = result.pages
      .flatMap((page) => page.systems)
      .flatMap((system) => system.bars)
      .map((bar) => bar.metrics.status);
    expect(statuses).toEqual(['under', 'exact', 'over']);

    expect(() => draw(score)).not.toThrow();
  });
});
