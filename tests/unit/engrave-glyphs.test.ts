import {
  BOTTOM_LINE,
  MIDDLE_LINE,
  TOP_LINE,
  clef,
  digits,
  endBarline,
  keySignature,
  musicFontNamed,
  positionY,
  restFor,
  restPosition,
  startBarline,
  startBarlineWidth,
  timeSignature,
} from '@sibei/engrave';
import { dur } from '@sibei/model';
import { describe, expect, it } from 'vitest';

/**
 * The glyphs that are not notes: rests, the clef, key and time signatures, and barlines.
 *
 * Almost all of this is placement rather than shape — the shapes are the font's — so what
 * is worth asserting is the handful of conventions that are neither in the font nor
 * obvious, and that look plausible when they are wrong.
 */

const font = musicFontNamed();
const STAVE_Y = 200;

describe('rests', () => {
  it('picks the glyph the duration names', () => {
    expect(restFor(dur(1))).toBe('restWhole');
    expect(restFor(dur(2))).toBe('restHalf');
    expect(restFor(dur(4))).toBe('restQuarter');
    expect(restFor(dur(8))).toBe('rest8th');
    expect(restFor(dur(16))).toBe('rest16th');
    expect(restFor(dur(32))).toBe('rest32nd');
  });

  it('hangs a whole rest from the second line and sits everything else on the middle', () => {
    // The one placement rule that is not "centre it": a whole rest hangs beneath the
    // line above the middle, and a half rest sits on the middle line. Swapping the two
    // is the classic error, and both look like a rest in about the right place.
    expect(restPosition(dur(1))).toBe(2);
    expect(restPosition(dur(2))).toBe(MIDDLE_LINE);
    expect(restPosition(dur(4))).toBe(MIDDLE_LINE);
    expect(restPosition(dur(8))).toBe(MIDDLE_LINE);
  });

  it('draws a whole rest below its origin and a half rest above it', () => {
    // Which is what makes the positions above correct: the two glyphs are mirror images
    // about the line they attach to, and the font says so.
    expect(font.data.glyphs.restWhole.bBoxSW[1]).toBeLessThan(0);
    expect(font.data.glyphs.restWhole.bBoxNE[1]).toBeLessThanOrEqual(0.1);
    expect(font.data.glyphs.restHalf.bBoxNE[1]).toBeGreaterThan(0);
    expect(font.data.glyphs.restHalf.bBoxSW[1]).toBeGreaterThanOrEqual(-0.1);
  });
});

describe('the clef', () => {
  it('puts a G clef on the G line, second from the bottom', () => {
    const element = clef(font, 0, STAVE_Y);
    expect(element.attrs['transform']).toContain(`,${positionY(6, STAVE_Y)})`);
  });
});

describe('the key signature', () => {
  it('writes flats in their conventional order and nowhere else', () => {
    // Eb major: Bb on the middle line, Eb in the top space, Ab in the second space up
    // from the bottom. Positions, not octaves — a formula that just walks down by
    // fourths puts the Ab below the staff.
    const { elements } = keySignature(font, -3, 0, STAVE_Y);
    expect(elements).toHaveLength(3);
    const ys = elements.map((element) => String(element.attrs['transform']));
    expect(ys[0]).toContain(`,${positionY(MIDDLE_LINE, STAVE_Y)})`);
    expect(ys[1]).toContain(`,${positionY(1, STAVE_Y)})`);
    expect(ys[2]).toContain(`,${positionY(5, STAVE_Y)})`);
    for (const element of elements) expect(element.attrs['class']).toContain('accidentalFlat');
  });

  it('writes sharps starting on the top line', () => {
    const { elements } = keySignature(font, 2, 0, STAVE_Y);
    expect(elements).toHaveLength(2);
    expect(String(elements[0]?.attrs['transform'])).toContain(`,${positionY(TOP_LINE, STAVE_Y)})`);
    for (const element of elements) expect(element.attrs['class']).toContain('accidentalSharp');
  });

  it('draws nothing for C major, and never more than seven', () => {
    expect(keySignature(font, 0, 0, STAVE_Y).elements).toHaveLength(0);
    expect(keySignature(font, 0, 0, STAVE_Y).width).toBe(0);
    expect(keySignature(font, 12, 0, STAVE_Y).elements).toHaveLength(7);
    expect(keySignature(font, -12, 0, STAVE_Y).elements).toHaveLength(7);
  });

  it('advances by the accidental it is actually drawing', () => {
    // A flat is narrower than a sharp, so a key of flats is narrower than a key of the
    // same number of sharps. Hard-coding one width would make one of them look wrong.
    expect(keySignature(font, -3, 0, STAVE_Y).width).toBeLessThan(
      keySignature(font, 3, 0, STAVE_Y).width,
    );
  });
});

describe('the time signature', () => {
  it('stacks numerator over denominator', () => {
    const { elements } = timeSignature(font, { beats: 4, beatValue: 4 }, 0, STAVE_Y);
    expect(elements).toHaveLength(2);
    expect(String(elements[0]?.attrs['transform'])).toContain(`,${positionY(2, STAVE_Y)})`);
    expect(String(elements[1]?.attrs['transform'])).toContain(`,${positionY(6, STAVE_Y)})`);
  });

  it('centres a two-digit numerator over a one-digit denominator', () => {
    const { elements, width } = timeSignature(font, { beats: 12, beatValue: 8 }, 0, STAVE_Y);
    expect(elements).toHaveLength(3);
    // The single 8 starts further right than the 1 of the 12, because it is centred.
    const denominatorX = Number(/translate\(([\d.]+),/.exec(String(elements[2]?.attrs['transform']))?.[1]);
    expect(denominatorX).toBeGreaterThan(0);
    expect(width).toBeGreaterThan(font.width('timeSig8'));
  });

  it('splits a number into its digits', () => {
    expect(digits(4)).toEqual([4]);
    expect(digits(12)).toEqual([1, 2]);
    expect(digits(0)).toEqual([0]);
  });
});

describe('barlines', () => {
  const RIGHT = 500;

  /** The rightmost edge of any ink a barline draws. */
  function rightEdge(elements: { attrs: Readonly<Record<string, string | number>> }[]): number {
    return Math.max(
      ...elements.map((element) => {
        const x = Number(element.attrs['x'] ?? 0);
        const width = Number(element.attrs['width'] ?? 0);
        return Number.isNaN(x) ? 0 : x + (Number.isNaN(width) ? 0 : width);
      }),
    );
  }

  it('lands a closing barline exactly on the bar edge, whatever kind it is', () => {
    // Bars share an edge, so a barline that overshoots leaves the next bar's music
    // starting inside it.
    for (const kind of ['single', 'double', 'final', 'repeat-end'] as const) {
      const elements = endBarline(font, kind, RIGHT, STAVE_Y).filter(
        (element) => element.name === 'rect',
      );
      expect(rightEdge(elements)).toBeCloseTo(RIGHT, 6);
    }
  });

  it('makes the closing line of a final barline the thick one', () => {
    const rects = endBarline(font, 'final', RIGHT, STAVE_Y).filter((e) => e.name === 'rect');
    const last = rects[rects.length - 1];
    expect(Number(last?.attrs['width'])).toBeCloseTo(font.ink.thickBarline, 6);
    expect(font.ink.thickBarline).toBeGreaterThan(font.ink.thinBarline);
  });

  it('gives a repeat its dots, on both sides', () => {
    const start = startBarline(font, 'repeat-start', 0, STAVE_Y);
    const end = endBarline(font, 'repeat-end', RIGHT, STAVE_Y);
    for (const elements of [start, end]) {
      const dots = elements.filter((element) => String(element.attrs['class']).includes('repeatDot'));
      expect(dots).toHaveLength(2);
      // In the two spaces either side of the middle line.
      expect(String(dots[0]?.attrs['transform'])).toContain(`,${positionY(3, STAVE_Y)})`);
      expect(String(dots[1]?.attrs['transform'])).toContain(`,${positionY(5, STAVE_Y)})`);
    }
  });

  it('reports the room an opening repeat needs, and none for no barline', () => {
    expect(startBarlineWidth(font, 'none')).toBe(0);
    expect(startBarline(font, 'none', 0, STAVE_Y)).toEqual([]);
    expect(startBarlineWidth(font, 'repeat-start')).toBeGreaterThan(font.ink.thickBarline);
  });

  it('runs every barline the full height of the staff', () => {
    const height = positionY(BOTTOM_LINE, STAVE_Y) - positionY(TOP_LINE, STAVE_Y);
    for (const element of endBarline(font, 'double', RIGHT, STAVE_Y)) {
      expect(Number(element.attrs['y'])).toBeCloseTo(positionY(TOP_LINE, STAVE_Y), 6);
      expect(Number(element.attrs['height'])).toBeCloseTo(height, 6);
    }
  });
});
