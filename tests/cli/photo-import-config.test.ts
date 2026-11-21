import { describe, expect, it } from 'vitest';
import { resolvePhotoImport } from '@sibei/cli';

describe('SBSCORE_PHOTO_IMPORT (SIB2-201)', () => {
  it('defaults off when hosted and on locally', () => {
    expect(resolvePhotoImport(true, {})).toBe(false);
    expect(resolvePhotoImport(false, {})).toBe(true);
  });
  it('can be set either way', () => {
    expect(resolvePhotoImport(true, { SBSCORE_PHOTO_IMPORT: 'on' })).toBe(true);
    expect(resolvePhotoImport(false, { SBSCORE_PHOTO_IMPORT: 'OFF' })).toBe(false);
  });
  it('refuses anything else', () => {
    expect(() => resolvePhotoImport(false, { SBSCORE_PHOTO_IMPORT: 'maybe' })).toThrow(/on.* or .*off/);
  });
});
