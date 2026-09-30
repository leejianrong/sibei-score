import { OMR_SCHEMA_VERSION } from '@sibei/model';
import type { OmrDocument } from '@sibei/model';

/**
 * Fixtures shared by the import-runner tests (V18/V19). Not a test file.
 */

/**
 * A recognised page with one staff and one note, so V11's mapper produces a real score (an empty
 * `staves` throws `OmrMappingError` — the "no staff" case is its own test below).
 */
export function aDocument(imagePath = 'page-1'): OmrDocument {
  return {
    schemaVersion: OMR_SCHEMA_VERSION,
    source: {
      engine: 'oemer',
      engineVersion: '0.1.8',
      imagePath,
      imageWidth: 1612,
      imageHeight: 2280,
      provider: 'CPUExecutionProvider',
      wallClockSeconds: 321,
    },
    staves: [
      { index: 0, track: 0, group: 0, xLeft: 100, xRight: 1000, yUpper: 100, yLower: 164, yCenter: 132, unitSize: 16 },
    ],
    zones: [],
    noteheads: [
      {
        id: 0,
        bbox: [291, 120, 309, 136],
        track: 0,
        group: 0,
        noteGroupId: null,
        staffLinePos: null,
        pitch: null,
        hasDot: false,
        stemUp: true,
        invalid: false,
        label: 'QUARTER',
      },
    ],
    noteGroups: [],
    barlines: [],
    rests: [],
    bandTokens: [],
  };
}

/** A one-pixel PNG, so the runner's format re-detection finds a real image in the blob. */
export function pngBytes(): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(1, 8);
  ihdr.writeUInt32BE(1, 12);
  return Buffer.concat([sig, ihdr]);
}

