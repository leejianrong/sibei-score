import { describe, expect, it } from 'vitest';
import { displayId } from '../../packages/ui/src/lib/format.js';

describe('displayId (SIB2-271)', () => {
  it('shortens an import id and leaves a chosen one alone', () => {
    expect(displayId('import-3f2a9c1e-7b4d-4e6a-9a1c-0d5e8f7b6a21')).toBe('import-3f2a9c1e');
    expect(displayId('audio-3f2a9c1e-7b4d-4e6a-9a1c-0d5e8f7b6a21')).toBe('audio-3f2a9c1e');
    expect(displayId('blue-monk-kwm0r')).toBe('blue-monk-kwm0r');
  });
});
