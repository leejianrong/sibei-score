import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOmrDocument, type OmrDocument } from '@sibei/model';

/**
 * The V9 test plan's End-to-end clause: "running the spike on a fixture photo produces
 * JSON containing at least one staff, and notes and barlines each carrying non-null pixel
 * coordinates".
 *
 * The spike itself needs Python, oemer and ~104 MB of ONNX weights, so it does NOT run in
 * CI (it is a standalone script by design — ADR-0023, Q71). What runs here is the
 * committed artefact of a real spike run: the JSON `sibei_omr.spike` produced on a
 * rendered `aaba-chart` page. That the recognition happened is a property of the file; that
 * it happened *usefully* — a staff, notes and barlines all with coordinates — is what this
 * asserts. Regenerate the fixture with `worker/`'s spike; see worker/README.md.
 */

const doc: OmrDocument = parseOmrDocument(
  JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/omr/aaba-chart.omr.json'), 'utf8')),
);

describe('the oemer coordinate spike output', () => {
  it('detected at least one staff', () => {
    expect(doc.staves.length).toBeGreaterThanOrEqual(1);
  });

  it('detected noteheads, each carrying non-null pixel coordinates', () => {
    expect(doc.noteheads.length).toBeGreaterThanOrEqual(1);
    for (const note of doc.noteheads) {
      expect(note.bbox).toHaveLength(4);
      expect(note.bbox.every((v) => typeof v === 'number')).toBe(true);
    }
  });

  it('detected barlines, each carrying non-null pixel coordinates', () => {
    expect(doc.barlines.length).toBeGreaterThanOrEqual(1);
    for (const barline of doc.barlines) {
      expect(barline.bbox).toHaveLength(4);
      expect(barline.bbox.every((v) => typeof v === 'number')).toBe(true);
    }
  });

  it('recorded a CPU wall-clock measurement (ADR-0025)', () => {
    expect(doc.source.provider).toContain('CPU');
    expect(doc.source.wallClockSeconds).toBeGreaterThan(0);
  });
});
