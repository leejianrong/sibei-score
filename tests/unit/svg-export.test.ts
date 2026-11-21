import { describe, expect, it } from 'vitest';
import { createExporter, memoryBlobStore, parseExportPage } from '@sibei/api';
import type { ScoreReader } from '@sibei/api';
import { longFormChart, nastyChart } from '@sibei/fixtures';
import { renderScoreToSvg } from '@sibei/pdf';
import { renderScorePages } from '@sibei/ui';
import type { Score } from '@sibei/model';

/** `export format=svg&page=N` (SIB2-190): the browser's own SVG, one page at a time. */

function exporterFor(score: Score) {
  const reader = {
    get: async () => ({ score, version: 1 }),
  } as unknown as ScoreReader;
  return createExporter(reader, memoryBlobStore());
}

const request = { format: 'svg', instrument: 'concert', paper: 'a4', font: 'normal' } as const;

describe('svg export', () => {
  it('is the browser SVG byte for byte, page by page, and says how many pages there are', async () => {
    const score = longFormChart();
    const exporter = exporterFor(score);
    const browser = renderScorePages(score, { paper: 'a4' }, { font: 'normal' }).map((p) => p.svg);
    expect(browser.length).toBeGreaterThan(1);
    for (const [index, svg] of browser.entries()) {
      const outcome = await exporter.export('local', 'chart', { ...request, page: index + 1 });
      if (!outcome.ok) throw new Error('expected an artefact');
      expect(outcome.artefact.bytes.toString('utf8')).toBe(svg);
      expect(outcome.artefact.pages).toBe(browser.length);
      expect(outcome.artefact.contentType).toBe('image/svg+xml');
      expect(outcome.artefact.filename).toBe(`The Long Way Home - page ${index + 1}.svg`);
    }
    expect(renderScoreToSvg(score).map((p) => p.svg)).toEqual(browser);
  });

  it('defaults to page 1, serves a repeat from the cache with the same count, and refuses a page past the end', async () => {
    const score = nastyChart();
    const exporter = exporterFor(score);
    const first = await exporter.export('local', 'chart', request);
    const again = await exporter.export('local', 'chart', { ...request, page: 1 });
    if (!first.ok || !again.ok) throw new Error('expected artefacts');
    expect(first.artefact.cached).toBe(false);
    expect(again.artefact.cached).toBe(true);
    expect(again.artefact.pages).toBe(first.artefact.pages);
    expect(await exporter.export('local', 'chart', { ...request, page: 9 })).toEqual({
      ok: false,
      reason: 'no-such-page',
      pages: 1,
    });
  });

  it('parses the page query: a positive whole number, nothing else', () => {
    expect(parseExportPage(null)).toBe(1);
    expect(parseExportPage('3')).toBe(3);
    for (const bad of ['0', '-1', '1.5', 'two', '10000']) expect(parseExportPage(bad)).toBeNull();
  });
});
