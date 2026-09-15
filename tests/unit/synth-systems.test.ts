import { layout } from '@sibei/layout';
import {
  buildVocabulary,
  extractLabels,
  extractSystemLabels,
  generateScore,
  itemSequence,
  tokenSymbol,
} from '@sibei/synth';
import { describe, expect, it } from 'vitest';

/**
 * The Stage-2a training unit is one staff system: its crop box and its note/rest sequence (V15a,
 * ADR-0031). Two properties keep it honest. The tokens across all systems must equal the score's own
 * page-level ground truth (same data, finer granularity — a drift here would train the model against
 * labels that disagree with what the eval scores). And every crop box must sit inside its page, or
 * the imaging step would extract off the canvas.
 */

describe('extractSystemLabels', () => {
  it('yields one label per system, in page-then-system order', () => {
    const score = generateScore({ seed: 3, bars: 16 });
    const result = layout(score);
    const labels = extractSystemLabels(score);
    expect(labels).toHaveLength(result.systemCount);
    expect(labels.map((l) => l.index)).toEqual(labels.map((_, i) => i));
  });

  it('reconstructs the score ground truth when systems are concatenated', () => {
    // The invariant that ties crop-level labels to the page-level truth the eval uses.
    for (let seed = 0; seed < 30; seed += 1) {
      const score = generateScore({ seed, bars: 16 });
      const fromSystems = extractSystemLabels(score).flatMap((l) => l.tokens);
      const fromScore = itemSequence(extractLabels(score));
      expect(fromSystems).toEqual(fromScore);
    }
  });

  it('carries vocabulary ids that match the token symbols', () => {
    const vocab = buildVocabulary();
    const labels = extractSystemLabels(generateScore({ seed: 9, bars: 16 }), { vocab });
    for (const label of labels) {
      expect(label.tokenIds).toBeDefined();
      expect(label.tokenIds).toHaveLength(label.tokens.length);
      label.tokenIds!.forEach((id, i) => {
        expect(vocab.symbols[id]).toBe(tokenSymbol(label.tokens[i]!));
      });
    }
  });

  it('omits ids when no vocabulary is supplied', () => {
    const labels = extractSystemLabels(generateScore({ seed: 1 }));
    expect(labels.every((l) => l.tokenIds === undefined)).toBe(true);
  });

  it('keeps every crop box inside its page with a positive extent', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const score = generateScore({ seed, bars: 20 });
      const result = layout(score);
      for (const label of extractSystemLabels(score)) {
        const page = result.pages[label.box.page];
        expect(page).toBeDefined();
        expect(label.box.width).toBeGreaterThan(0);
        expect(label.box.height).toBeGreaterThan(0);
        expect(label.box.x).toBeGreaterThanOrEqual(0);
        expect(label.box.y).toBeGreaterThanOrEqual(0);
        expect(label.box.x + label.box.width).toBeLessThanOrEqual(page!.width + 1e-6);
        expect(label.box.y + label.box.height).toBeLessThanOrEqual(page!.height + 1e-6);
      }
    }
  });
});
