import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OMR_SCHEMA_VERSION,
  OmrSchemaError,
  parseOmrDocument,
  type OmrDocument,
} from '@sibei/model';

/**
 * The V9 test plan's Unit clause: "the dumped structure conforms to the worker output
 * schema owned by the `model` package". `parseOmrDocument` IS that schema; this proves it
 * accepts a well-formed document and rejects each way one can be malformed, and — the part
 * that makes it a contract across the language boundary (ADR-0005) — that the JSON the
 * Python spike actually produced parses clean.
 */

function validDocument(): OmrDocument {
  return {
    schemaVersion: OMR_SCHEMA_VERSION,
    source: {
      engine: 'oemer',
      engineVersion: '0.1.8',
      imagePath: 'chart.png',
      imageWidth: 1000,
      imageHeight: 1400,
      provider: 'CPUExecutionProvider',
      wallClockSeconds: 42.5,
    },
    staves: [
      {
        index: 0,
        track: 0,
        group: 0,
        xLeft: 50,
        xRight: 950,
        yUpper: 100,
        yLower: 160,
        yCenter: 130,
        unitSize: 12,
      },
    ],
    zones: [[80, 200]],
    noteheads: [
      {
        id: 0,
        bbox: [120, 118, 138, 134],
        track: 0,
        group: 0,
        noteGroupId: 0,
        staffLinePos: 2,
        pitch: 71,
        hasDot: false,
        stemUp: true,
        invalid: false,
        label: 'QUARTER',
      },
    ],
    noteGroups: [
      { id: 0, bbox: [118, 90, 140, 135], track: 0, group: 0, noteIds: [0], stemUp: true, hasStem: true },
    ],
    barlines: [{ bbox: [300, 100, 303, 160], group: 0 }],
    rests: [{ bbox: [400, 115, 418, 145], track: 0, group: 0, hasDot: false, label: 'QUARTER' }],
  };
}

describe('parseOmrDocument', () => {
  it('accepts a well-formed document and returns it typed', () => {
    const doc = validDocument();
    expect(parseOmrDocument(doc)).toBe(doc);
  });

  it('accepts the nullable attributes oemer legitimately leaves unset', () => {
    const doc = validDocument();
    doc.noteheads[0]!.pitch = null;
    doc.noteheads[0]!.stemUp = null;
    doc.noteheads[0]!.label = null;
    doc.staves[0]!.unitSize = null;
    doc.staves[0]!.track = null;
    doc.rests[0]!.hasDot = null;
    expect(() => parseOmrDocument(doc)).not.toThrow();
  });

  it('rejects a non-object', () => {
    expect(() => parseOmrDocument(null)).toThrow(OmrSchemaError);
    expect(() => parseOmrDocument(42)).toThrow(OmrSchemaError);
    expect(() => parseOmrDocument([])).toThrow(OmrSchemaError);
  });

  it('rejects the wrong schema version', () => {
    const doc = { ...validDocument(), schemaVersion: 99 };
    expect(() => parseOmrDocument(doc)).toThrow(/schemaVersion is 99/);
  });

  it('requires a notehead bbox — the coordinate is the point (ADR-0010)', () => {
    const doc = validDocument();
    (doc.noteheads[0] as unknown as Record<string, unknown>).bbox = null;
    expect(() => parseOmrDocument(doc)).toThrow(/noteheads\[0\]\.bbox is not \[x1, y1, x2, y2\]/);
  });

  it('rejects a bbox with the wrong arity or a non-number', () => {
    const doc = validDocument();
    (doc.barlines[0] as unknown as Record<string, unknown>).bbox = [1, 2, 3];
    expect(() => parseOmrDocument(doc)).toThrow(/barlines\[0\]\.bbox/);
  });

  it('rejects a negative or inside-out bbox', () => {
    const negative = validDocument();
    negative.noteheads[0]!.bbox = [-1, 0, 10, 10];
    expect(() => parseOmrDocument(negative)).toThrow(/negative coordinate/);

    const insideOut = validDocument();
    insideOut.noteheads[0]!.bbox = [10, 10, 5, 5];
    expect(() => parseOmrDocument(insideOut)).toThrow(/inside-out/);
  });

  it('rejects a missing source field', () => {
    const doc = validDocument();
    delete (doc.source as unknown as Record<string, unknown>).imageWidth;
    expect(() => parseOmrDocument(doc)).toThrow(/source\.imageWidth is not a number/);
  });

  it('collects every problem, not just the first', () => {
    const doc = validDocument();
    (doc as unknown as Record<string, unknown>).schemaVersion = 99;
    (doc.source as unknown as Record<string, unknown>).engine = 42;
    doc.noteheads[0]!.bbox = [-1, 0, 10, 10];
    try {
      parseOmrDocument(doc);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(OmrSchemaError);
      expect((error as OmrSchemaError).problems.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('accepts the JSON the spike actually produced (the committed real dump)', () => {
    const raw = readFileSync(join(import.meta.dirname, '../fixtures/omr/aaba-chart.omr.json'), 'utf8');
    const doc = parseOmrDocument(JSON.parse(raw));
    expect(doc.schemaVersion).toBe(OMR_SCHEMA_VERSION);
  });
});
