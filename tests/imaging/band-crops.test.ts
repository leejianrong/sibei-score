import { CANONICAL_CHORD_STYLE } from '@sibei/engrave';
import { buildChordVocabulary, extractSystemChords, generateScore } from '@sibei/synth';
import { renderBandCrops } from '@sibei/synth/imaging';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

/**
 * Chord-band crops — the pixel half of the Stage-2b corpus (V17b, ADR-0031). Infra-layer: `sharp`/resvg
 * are native bindings (KAN-514). These pin that a crop is produced per chord-carrying system, that its
 * CTC target matches the vocabulary encoding of its labels, and that it is deterministic.
 */

describe('renderBandCrops', () => {
  const vocab = buildChordVocabulary();

  it('produces one decodable crop per chord-carrying system, with matching labels and tokenIds', async () => {
    const score = generateScore({ seed: 4, bars: 12, chords: true });
    const style = CANONICAL_CHORD_STYLE;
    const crops = await renderBandCrops(score, { vocab, chordStyle: style, zoom: 2 });
    const systems = extractSystemChords(score, { style }).filter((s) => s.hasBand);

    expect(crops.length).toBe(systems.length);
    expect(crops.length).toBeGreaterThan(0);

    for (const crop of crops) {
      const meta = await sharp(crop.png).metadata();
      expect(meta.format).toBe('png');
      expect(meta.width).toBeGreaterThan(0);
      expect(meta.height).toBeGreaterThan(0);
      // The band is a wide, short strip.
      expect(meta.width as number).toBeGreaterThan(meta.height as number);
      // The CTC target is the vocabulary encoding of this crop's own labels.
      expect(crop.tokenIds).toEqual(vocab.encodeBand(crop.chords));
      expect(crop.chords.length).toBeGreaterThan(0);
    }
  });

  it('produces no crops for a chordless score', async () => {
    const score = generateScore({ seed: 4, bars: 12, chords: false });
    const crops = await renderBandCrops(score, { vocab });
    expect(crops).toEqual([]);
  });

  it('is deterministic for a given style', async () => {
    const score = generateScore({ seed: 7, bars: 8, chords: true });
    const a = await renderBandCrops(score, { vocab, chordStyle: CANONICAL_CHORD_STYLE, zoom: 1 });
    const b = await renderBandCrops(score, { vocab, chordStyle: CANONICAL_CHORD_STYLE, zoom: 1 });
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i += 1) {
      expect(a[i]!.png.equals(b[i]!.png)).toBe(true);
      expect(a[i]!.tokenIds).toEqual(b[i]!.tokenIds);
    }
  });
});
