import {
  BOTTOM_LINE,
  INK,
  MIDDLE_LINE,
  STANDARD_STEM,
  TOP_LINE,
  anchor,
  glyphWidth,
  hasAnchor,
  ledgerPositions,
  positionY,
  stem,
  stemDirection,
} from '@sibei/engrave';
import { describe, expect, it } from 'vitest';

/**
 * Glyph anchoring, which is the assumption V1b exists to test: that Bravura's published
 * metrics are enough to place a stem without a hand-tuned per-glyph offset (ADR-0030).
 *
 * The claims below are checked against the font's own numbers rather than against
 * remembered ones, so they would fail if the vendored slice were regenerated from a
 * release whose noteheads had moved.
 */

const STAVE_Y = 200;

/** Every position the fixture reaches, and then some: two ledger lines either side. */
const POSITIONS = Array.from({ length: 17 }, (_, index) => index - 4);

describe('stem attachment from Bravura anchors', () => {
  it("puts an up stem's right edge on the notehead's right edge, at every staff position", () => {
    const width = glyphWidth('noteheadBlack');
    // The anchor and the bounding box agree in the font: stemUpSE.x is the notehead's
    // advance width. That is the fact the claim rests on, so assert it directly.
    expect(anchor('noteheadBlack', 'stemUpSE').x).toBeCloseTo(width, 10);

    for (const position of POSITIONS) {
      const result = stem({
        notehead: 'noteheadBlack',
        direction: 'up',
        noteX: 100,
        position,
        staveY: STAVE_Y,
      });
      expect(result.right).toBeCloseTo(100 + width, 10);
      expect(result.left).toBeCloseTo(100 + width - INK.stem, 10);
    }
  });

  it("puts a down stem's left edge on the notehead's left edge", () => {
    for (const position of POSITIONS) {
      const result = stem({
        notehead: 'noteheadBlack',
        direction: 'down',
        noteX: 100,
        position,
        staveY: STAVE_Y,
      });
      expect(result.left).toBeCloseTo(100, 10);
      expect(result.right).toBeCloseTo(100 + INK.stem, 10);
    }
  });

  it('attaches inside the notehead, not at its vertical centre', () => {
    // Bravura puts both stem anchors a sixth of a space off centre, so the stem meets
    // the notehead's shoulder. Attaching at the centre is the plausible-looking mistake.
    const noteY = positionY(2, STAVE_Y);
    const up = stem({
      notehead: 'noteheadBlack',
      direction: 'up',
      noteX: 0,
      position: 2,
      staveY: STAVE_Y,
    });
    const down = stem({
      notehead: 'noteheadBlack',
      direction: 'down',
      noteX: 0,
      position: 2,
      staveY: STAVE_Y,
    });
    expect(up.attachY).toBeLessThan(noteY);
    expect(down.attachY).toBeGreaterThan(noteY);
    expect(up.attachY).toBeCloseTo(noteY + anchor('noteheadBlack', 'stemUpSE').y, 10);
    expect(down.attachY).toBeCloseTo(noteY + anchor('noteheadBlack', 'stemDownNW').y, 10);
  });

  it('refuses an anchor the font does not publish', () => {
    // A whole note has no stem anchors, because it has no stem. Silently reading zero
    // would put a stem at the glyph's origin, which looks very nearly right.
    expect(hasAnchor('noteheadWhole', 'stemUpSE')).toBe(false);
    expect(() => anchor('noteheadWhole', 'stemUpSE')).toThrow(/no stemUpSE anchor/);
  });

  it('anchors a flag to the free end of the stem', () => {
    expect(hasAnchor('flag8thUp', 'stemUpNW')).toBe(true);
    expect(hasAnchor('flag16thDown', 'stemDownSW')).toBe(true);
  });
});

describe('stem direction and length', () => {
  it('points away from the middle line, and down for a note sitting on it', () => {
    expect(stemDirection(TOP_LINE)).toBe('down');
    expect(stemDirection(MIDDLE_LINE - 1)).toBe('down');
    expect(stemDirection(MIDDLE_LINE)).toBe('down');
    expect(stemDirection(MIDDLE_LINE + 1)).toBe('up');
    expect(stemDirection(BOTTOM_LINE)).toBe('up');
  });

  it('runs three and a half spaces from the notehead', () => {
    const result = stem({
      notehead: 'noteheadBlack',
      direction: 'down',
      noteX: 0,
      position: TOP_LINE,
      staveY: STAVE_Y,
    });
    expect(result.endY - positionY(TOP_LINE, STAVE_Y)).toBeCloseTo(STANDARD_STEM, 10);
  });

  it('lengthens a stem so a note outside the staff still reaches the middle line', () => {
    // E3 sits five spaces below the staff; a standard stem would stop short of it.
    const position = 15;
    const result = stem({
      notehead: 'noteheadBlack',
      direction: 'up',
      noteX: 0,
      position,
      staveY: STAVE_Y,
    });
    expect(result.endY).toBeCloseTo(positionY(MIDDLE_LINE, STAVE_Y), 10);
    expect(positionY(position, STAVE_Y) - result.endY).toBeGreaterThan(STANDARD_STEM);
  });
});

describe('ledger lines', () => {
  it('gives a note on the staff none', () => {
    for (let position = TOP_LINE; position <= BOTTOM_LINE; position += 1) {
      expect(ledgerPositions(position)).toEqual([]);
    }
    // And the spaces just outside the staff are still clear.
    expect(ledgerPositions(-1)).toEqual([]);
    expect(ledgerPositions(9)).toEqual([]);
  });

  it('continues the staff outward, as far as the note', () => {
    expect(ledgerPositions(-2)).toEqual([-2]); // A5, on the first line above
    expect(ledgerPositions(-3)).toEqual([-2]); // B5, in the space above it
    expect(ledgerPositions(-4)).toEqual([-2, -4]); // C6
    expect(ledgerPositions(10)).toEqual([10]); // C4
    expect(ledgerPositions(15)).toEqual([10, 12, 14]); // E3
  });
});
