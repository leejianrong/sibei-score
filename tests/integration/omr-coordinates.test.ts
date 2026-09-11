import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOmrDocument, type BBox, type OmrDocument, type OmrStaff } from '@sibei/model';

/**
 * The V9 test plan's Integration clause: "the dumped coordinates land inside the source
 * image's bounds, and note coordinates fall within their staff's vertical extent".
 *
 * These are the two invariants that make a coordinate *usable* for stage 3 (ADR-0010): a
 * coordinate outside the image is meaningless, and a note that does not sit near a staff is
 * either misdetected or mis-located. Run against the committed real spike output; the spike
 * itself does not run in CI (see tests/e2e/omr-spike.test.ts).
 *
 * "Vertical extent" is read as the staff's own line span (`yUpper`..`yLower`) widened by a
 * full staff-height on each side — a generous, self-scaling allowance for the ledger lines a
 * melody note legitimately rides above or below the five lines. A note is tied to its
 * *nearest* staff by vertical centre.
 *
 * It deliberately does NOT use oemer's `zones` layer: the V9 spike found `zones` covered only
 * the upper part of the page on this fixture (it ended at y≈1513 while staves and noteheads ran
 * to y≈2027), so it is not a reliable container. The per-staff extents are — every notehead in
 * the real dump sits within ~2 staff-spaces of its nearest staff centre. See worker/README.md.
 */

const doc: OmrDocument = parseOmrDocument(
  JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/omr/aaba-chart.omr.json'), 'utf8')),
);

const yMid = (bbox: BBox): number => (bbox[1] + bbox[3]) / 2;

/**
 * The vertical extent a note is allowed to sit in: the staff's line span widened by one
 * staff-height each way for ledger lines.
 */
function extentFor(staff: OmrStaff): [number, number] {
  const height = staff.yLower - staff.yUpper;
  return [staff.yUpper - height, staff.yLower + height];
}

function nearestStaff(y: number): OmrStaff {
  return doc.staves.reduce((best, s) =>
    Math.abs(s.yCenter - y) < Math.abs(best.yCenter - y) ? s : best,
  );
}

describe('oemer coordinate invariants', () => {
  const { imageWidth: W, imageHeight: H } = doc.source;

  it('every bounding box lands inside the image bounds', () => {
    const boxes: Array<{ what: string; bbox: BBox }> = [
      ...doc.noteheads.map((n, i) => ({ what: `notehead[${i}]`, bbox: n.bbox })),
      ...doc.noteGroups.map((g, i) => ({ what: `noteGroup[${i}]`, bbox: g.bbox })),
      ...doc.barlines.map((b, i) => ({ what: `barline[${i}]`, bbox: b.bbox })),
      ...doc.rests.map((r, i) => ({ what: `rest[${i}]`, bbox: r.bbox })),
    ];
    for (const { what, bbox } of boxes) {
      const [x1, y1, x2, y2] = bbox;
      expect(x1, `${what} x1`).toBeGreaterThanOrEqual(0);
      expect(y1, `${what} y1`).toBeGreaterThanOrEqual(0);
      expect(x2, `${what} x2`).toBeLessThanOrEqual(W);
      expect(y2, `${what} y2`).toBeLessThanOrEqual(H);
    }
  });

  it('every staff extent lands inside the image bounds', () => {
    for (const [i, s] of doc.staves.entries()) {
      expect(s.xLeft, `staff[${i}] xLeft`).toBeGreaterThanOrEqual(0);
      expect(s.yUpper, `staff[${i}] yUpper`).toBeGreaterThanOrEqual(0);
      expect(s.xRight, `staff[${i}] xRight`).toBeLessThanOrEqual(W);
      expect(s.yLower, `staff[${i}] yLower`).toBeLessThanOrEqual(H);
    }
  });

  it("each notehead sits within its nearest staff's vertical extent", () => {
    expect(doc.staves.length).toBeGreaterThanOrEqual(1);
    for (const [i, note] of doc.noteheads.entries()) {
      const y = yMid(note.bbox);
      const [lo, hi] = extentFor(nearestStaff(y));
      expect(y, `notehead[${i}] vertical centre in [${lo}, ${hi}]`).toBeGreaterThanOrEqual(lo);
      expect(y, `notehead[${i}] vertical centre in [${lo}, ${hi}]`).toBeLessThanOrEqual(hi);
    }
  });
});
