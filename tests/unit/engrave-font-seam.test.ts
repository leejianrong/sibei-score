import type { MusicFontData } from '@sibei/engrave';
import {
  BRAVURA,
  DEFAULT_MUSIC_FONT,
  MUSIC_FONT_NAMES,
  musicFont,
  musicFontNamed,
  stem,
  units,
} from '@sibei/engrave';
import { describe, expect, it } from 'vitest';

/**
 * The font seam: a face is chosen per render, not bound at import time.
 *
 * A lead sheet is read in a handwritten Real Book face as often as an engraved one, and
 * that is the reader's choice — so no geometry may reach for Bravura by name. Proving
 * that needs a *second* face, and there is only one vendored, so the tests below invent
 * one: Bravura with two numbers changed. If any thickness or attachment point were
 * hard-coded, the invented face would not move the ink and these would fail.
 *
 * The two numbers are not arbitrary. Petaluma really does attach an up stem at
 * `[1.336, 0.288]` staff spaces where Bravura uses `[1.18, 0.168]`, so this is the shape
 * of the difference a real second face makes (`docs/v1b-engraver-spike.md`).
 */

/** Bravura with a different stem thickness and a different stem attachment point. */
function inventedFace(): MusicFontData {
  return {
    ...BRAVURA,
    name: 'Invented',
    version: '0',
    engravingDefaults: { ...BRAVURA.engravingDefaults, stemThickness: 0.24 },
    glyphs: {
      ...BRAVURA.glyphs,
      noteheadBlack: {
        ...BRAVURA.glyphs.noteheadBlack,
        anchors: {
          ...BRAVURA.glyphs.noteheadBlack.anchors,
          stemUpSE: [1.336, 0.288],
          stemDownNW: [0, -0.236],
        },
      },
    },
  };
}

const bravura = musicFontNamed();
const invented = musicFont(inventedFace());

describe('the registry', () => {
  it('offers the faces the engraver can draw in, and defaults to one of them', () => {
    expect(MUSIC_FONT_NAMES.length).toBeGreaterThan(0);
    expect(MUSIC_FONT_NAMES).toContain(DEFAULT_MUSIC_FONT);
    expect(musicFontNamed(DEFAULT_MUSIC_FONT).data.name).toBe('Bravura');
  });

  it('resolves the same face to the same object, so a page render builds it once', () => {
    expect(musicFontNamed()).toBe(musicFontNamed(DEFAULT_MUSIC_FONT));
  });
});

describe('thicknesses come from the face, not from the engraver', () => {
  it('reads every one of them out of engravingDefaults', () => {
    const defaults = BRAVURA.engravingDefaults;
    expect(bravura.ink.stem).toBeCloseTo(units(defaults.stemThickness), 10);
    expect(bravura.ink.beam).toBeCloseTo(units(defaults.beamThickness), 10);
    expect(bravura.ink.staffLine).toBeCloseTo(units(defaults.staffLineThickness), 10);
    expect(bravura.ink.ledgerLine).toBeCloseTo(units(defaults.legerLineThickness), 10);
    expect(bravura.ink.ledgerExtension).toBeCloseTo(units(defaults.legerLineExtension), 10);
    expect(bravura.beamPitch).toBeCloseTo(bravura.ink.beam + bravura.ink.beamGap, 10);
  });

  it("draws a different face at that face's thickness", () => {
    expect(invented.ink.stem).toBeCloseTo(units(0.24), 10);
    expect(invented.ink.stem).toBeGreaterThan(bravura.ink.stem);
  });
});

describe('attachment points come from the face too', () => {
  const input = {
    notehead: 'noteheadBlack',
    noteX: 100,
    position: 6,
    staveY: 200,
  } as const;

  it('moves an up stem when the face moves its stemUpSE', () => {
    const theirs = stem(invented, { ...input, direction: 'up' });
    const ours = stem(bravura, { ...input, direction: 'up' });

    expect(ours.right).toBeCloseTo(100 + units(1.18), 10);
    expect(theirs.right).toBeCloseTo(100 + units(1.336), 10);
    // And the attachment height moves with it, in the other axis and the other sign.
    expect(ours.attachY).toBeCloseTo(230 - units(0.168), 10);
    expect(theirs.attachY).toBeCloseTo(230 - units(0.288), 10);
  });

  it('moves a down stem when the face moves its stemDownNW', () => {
    const theirs = stem(invented, { ...input, direction: 'down' });
    const ours = stem(bravura, { ...input, direction: 'down' });
    expect(ours.attachY).toBeCloseTo(230 + units(0.168), 10);
    expect(theirs.attachY).toBeCloseTo(230 + units(0.236), 10);
  });

  it("carries the face's stem thickness into the drawn rectangle", () => {
    // A stem positioned by one face and drawn at another's width would be a subtle,
    // face-dependent misalignment — so the width travels with the stem.
    expect(stem(bravura, { ...input, direction: 'up' }).thickness).toBeCloseTo(
      bravura.ink.stem,
      10,
    );
    expect(stem(invented, { ...input, direction: 'up' }).thickness).toBeCloseTo(
      invented.ink.stem,
      10,
    );
  });
});

describe("outlines are the face's own", () => {
  it("scales by the face's own units per staff space, never by a constant", () => {
    const wide = musicFont({ ...BRAVURA, fontUnitsPerStaffSpace: 500 });
    const bravuraTransform = bravura.element('noteheadBlack', 0, 0).attrs['transform'];
    const wideTransform = wide.element('noteheadBlack', 0, 0).attrs['transform'];
    expect(bravuraTransform).toContain('scale(0.04,-0.04)');
    expect(wideTransform).toContain('scale(0.02,-0.02)');
  });

  it('emits the path data verbatim, so the outline still matches the font', () => {
    const element = bravura.element('noteheadBlack', 10, 20);
    expect(element.attrs['d']).toBe(BRAVURA.glyphs.noteheadBlack.path);
    expect(element.attrs['transform']).toContain('translate(10,20)');
  });
});
