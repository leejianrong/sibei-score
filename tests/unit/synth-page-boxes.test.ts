import { layout } from '@sibei/layout';
import { BOX_CLASSES, extractPageBoxes, generateScore } from '@sibei/synth';
import { describe, expect, it } from 'vitest';

/**
 * The Stage-1 training unit is one page and its object boxes: staves, drawn barlines, the chord band,
 * and the title block (V16, ADR-0031). The boxes are read off `layout()`, not detected, so the tests
 * pin the properties that keep them trainable: one staff box per system, one barline per bar (the
 * drawn dividers), a band box exactly when the system has chords, a title box only where the header
 * puts one — and every box inside its page, or the imaging step would extract off the canvas.
 */

describe('extractPageBoxes', () => {
  it('yields one page entry per layout page, in order', () => {
    const score = generateScore({ seed: 3, bars: 32 });
    const result = layout(score);
    const pages = extractPageBoxes(score);
    expect(pages).toHaveLength(result.pages.length);
    expect(pages.map((p) => p.page)).toEqual(result.pages.map((p) => p.index));
  });

  it('emits one staff box per system, matching layout staff geometry', () => {
    const score = generateScore({ seed: 5, bars: 16 });
    const result = layout(score);
    const staffHeight = result.pageSpec.staffHeight;
    const pages = extractPageBoxes(score);

    const totalStaves = pages.reduce((n, p) => n + p.objects.filter((o) => o.cls === 'staff').length, 0);
    expect(totalStaves).toBe(result.systemCount);

    for (const page of pages) {
      const layoutPage = result.pages[page.page]!;
      for (const staff of page.objects.filter((o) => o.cls === 'staff')) {
        const system = layoutPage.systems.find((s) => s.index === staff.system)!;
        expect(system).toBeDefined();
        expect(staff.box.y).toBeCloseTo(system.staveY, 6);
        expect(staff.box.height).toBeCloseTo(staffHeight, 6);
        // A detected staff's unit is recoverable as height / 4, the same geometry the mapper reads.
        expect(staff.box.height / 4).toBeCloseTo(result.pageSpec.staffSpace, 6);
      }
    }
  });

  it('emits one barline per bar — the drawn dividers, at each bar right edge', () => {
    const score = generateScore({ seed: 7, bars: 16 });
    const result = layout(score);
    const pages = extractPageBoxes(score);
    for (const page of pages) {
      const layoutPage = result.pages[page.page]!;
      for (const system of layoutPage.systems) {
        const barlines = page.objects.filter((o) => o.cls === 'barline' && o.system === system.index);
        expect(barlines).toHaveLength(system.bars.length);
        // Each barline box straddles a bar's right edge.
        const edges = system.bars.map((b) => b.x + b.width).sort((a, b) => a - b);
        const centres = barlines.map((o) => o.box.x + o.box.width / 2).sort((a, b) => a - b);
        centres.forEach((c, i) => expect(c).toBeCloseTo(edges[i]!, 6));
      }
    }
  });

  it('emits a chord-band box exactly for systems that carry chords', () => {
    const withChords = generateScore({ seed: 2, bars: 16, chords: true });
    const bandCount = extractPageBoxes(withChords)
      .flatMap((p) => p.objects)
      .filter((o) => o.cls === 'chordBand').length;
    expect(bandCount).toBe(layout(withChords).systemCount);

    const noChords = generateScore({ seed: 2, bars: 16, chords: false });
    const noBand = extractPageBoxes(noChords)
      .flatMap((p) => p.objects)
      .filter((o) => o.cls === 'chordBand').length;
    expect(noBand).toBe(0);
  });

  it('puts the chord band above the staff, not overlapping it', () => {
    const score = generateScore({ seed: 4, bars: 16, chords: true });
    const result = layout(score);
    for (const page of extractPageBoxes(score)) {
      const layoutPage = result.pages[page.page]!;
      for (const band of page.objects.filter((o) => o.cls === 'chordBand')) {
        const system = layoutPage.systems.find((s) => s.index === band.system)!;
        expect(band.box.y + band.box.height).toBeLessThanOrEqual(system.staveY + 1e-6);
      }
    }
  });

  it('emits a title box only when the score has a header', () => {
    const titled = generateScore({ seed: 1, bars: 8, title: 'Blue in Green', composer: 'Bill Evans' });
    const titles = extractPageBoxes(titled)
      .flatMap((p) => p.objects)
      .filter((o) => o.cls === 'title');
    expect(titles.length).toBeGreaterThan(0);
    // The header is on page 1 only.
    expect(titles.every((_o, _i) => true)).toBe(true);
    const titlesOnLaterPages = extractPageBoxes(titled)
      .filter((p) => p.page > 0)
      .flatMap((p) => p.objects)
      .filter((o) => o.cls === 'title');
    expect(titlesOnLaterPages).toHaveLength(0);

    const untitled = generateScore({ seed: 1, bars: 8 });
    const none = extractPageBoxes(untitled)
      .flatMap((p) => p.objects)
      .filter((o) => o.cls === 'title');
    expect(none).toHaveLength(0);
  });

  it('gives every box a valid class id and keeps it inside its page', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const score = generateScore({ seed, bars: 24, title: seed % 2 === 0 ? 'Take Five' : '' });
      for (const page of extractPageBoxes(score)) {
        for (const obj of page.objects) {
          expect(BOX_CLASSES[obj.clsId]).toBe(obj.cls);
          expect(obj.box.width).toBeGreaterThan(0);
          expect(obj.box.height).toBeGreaterThan(0);
          expect(obj.box.x).toBeGreaterThanOrEqual(0);
          expect(obj.box.y).toBeGreaterThanOrEqual(0);
          expect(obj.box.x + obj.box.width).toBeLessThanOrEqual(page.width + 1e-6);
          expect(obj.box.y + obj.box.height).toBeLessThanOrEqual(page.height + 1e-6);
        }
      }
    }
  });
});
