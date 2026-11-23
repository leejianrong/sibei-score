import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deletedWords, describeBar, describeChord, describeItem, describeMany, durationName } from '@sibei/ui';

/**
 * SIB2-269: the sentences the live region says, and the contrast of the rail's text tokens. The tokens are read from
 * `app.css` itself, so a colour edited there is checked here and not a copy of it.
 */

describe('what is said out loud', () => {
  it('names durations the way a musician says them', () => {
    expect(durationName({ value: 4, dots: 0 })).toBe('quarter');
    expect(durationName({ value: 2, dots: 1 })).toBe('dotted half');
    expect(durationName({ value: 8, dots: 2 })).toBe('double-dotted eighth');
    expect(durationName({ value: 32, dots: 0 })).toBe('thirty-second');
  });

  it('describes a note, a rest and a chord by bar, beat, pitch and value', () => {
    expect(describeItem({ bar: 3, beat: 2, kind: 'note', pitch: 'G4', duration: { value: 4, dots: 0 } })).toBe('Bar 3, beat 2, note G4, quarter');
    expect(describeItem({ bar: 1, beat: 1.5, kind: 'rest', duration: { value: 8, dots: 0 } })).toBe('Bar 1, beat 1.5, rest, eighth');
    expect(describeItem({ bar: 2, beat: 1, kind: 'note', pitch: 'C4', extraTones: 2, duration: { value: 2, dots: 0 }, lane: 'Staff 2, voice 1' })).toBe(
      'Bar 2, beat 1, chord of 3 notes from C4, half, Staff 2, voice 1',
    );
  });

  it('describes a chord symbol, an empty slot, a bar and a many-item selection', () => {
    expect(describeChord(4, 1, 'Cmaj7')).toBe('Bar 4, chord Cmaj7, beat 1');
    expect(describeChord(4, 3, null)).toBe('Bar 4, beat 3, empty chord slot');
    expect(describeBar(5)).toBe('Bar 5 selected');
    expect(describeMany(3)).toBe('3 items selected');
    expect(deletedWords(1)).toBe('Deleted 1 item');
    expect(deletedWords(3)).toBe('Deleted 3 items');
  });
});

/** WCAG 2.x relative luminance and contrast ratio for #rrggbb. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}
function ratio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

describe('the rail colours meet WCAG AA for text (SIB2-269)', () => {
  const css = readFileSync(new URL('../../packages/ui/src/app.css', import.meta.url), 'utf8');
  const lightBlock = /:root \{([\s\S]*?)\n\}/.exec(css)![1]!;
  const darkBlock = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n  \}/.exec(css)![1]!;
  const tokens = (block: string): Record<string, string> => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/g)].map((m) => [m[1]!, m[2]!]));
  const light = tokens(lightBlock);
  const dark = { ...light, ...tokens(darkBlock) };

  for (const [theme, set] of [['light', light], ['dark', dark]] as const) {
    for (const background of ['panel', 'panel-2']) {
      for (const text of ['ink', 'ink-soft', 'ink-faint', 'accent', 'flag', 'danger']) {
        it(`${text} on ${background} in the ${theme} theme is at least 4.5:1`, () => {
          expect(set[text], text).toBeDefined();
          expect(ratio(set[text]!, set[background]!)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
    it(`text on an accent fill in the ${theme} theme is at least 4.5:1`, () => {
      expect(ratio(set['on-accent']!, set['accent']!)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
