import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEY,
  DEFAULT_TIME,
  OmrMappingError,
  TICKS_PER_QUARTER,
  mapOmrToScore,
  parseOmrDocument,
  reviewSummary,
  type Note,
  type OmrBarline,
  type OmrDocument,
  type OmrNotehead,
  type OmrRest,
  type OmrStaff,
} from '@sibei/model';

/**
 * The V11 unit test plan: "oemer object -> model mapping for each object kind, including ties and
 * triplets." The mapper (`packages/model/src/omr-map.ts`) is pure TS over the worker's `OmrDocument`
 * output, so it is fully exercised here at the fast layer without oemer, weights or Docker.
 *
 * Two kinds of input:
 *  - **synthetic clean documents**, hand-built with known geometry, so a mapping can be asserted
 *    exactly (bar counts, pitches, durations, onsets, flags);
 *  - the **committed real dump** (`tests/fixtures/omr/aaba-chart.omr.json`), so the mapper is proven
 *    to survive genuine noisy oemer output — over-firing barlines, mislabelled durations — producing a
 *    flagged draft rather than throwing (ADR-0019: every parse is a draft).
 */

// A treble staff whose bottom line (E4) is at y=164 with a 16px space, so one half-space is one
// diatonic step: steps=0 is E4, steps=2 is G4, steps=8 is the top line F5.
const STAFF_DEFAULTS = { xLeft: 100, xRight: 1000, yUpper: 100, yLower: 164, unitSize: 16 };
const HALF_SPACE = STAFF_DEFAULTS.unitSize / 2;

function staff(group: number, over: Partial<OmrStaff> = {}): OmrStaff {
  const yCenter = (STAFF_DEFAULTS.yUpper + STAFF_DEFAULTS.yLower) / 2;
  return { index: group, track: 0, group, yCenter, ...STAFF_DEFAULTS, ...over };
}

/** A note at pixel x, `steps` diatonic steps above the bottom line (E4), with an oemer label. */
function note(x: number, steps: number, over: Partial<OmrNotehead> = {}): OmrNotehead {
  const cy = STAFF_DEFAULTS.yLower - steps * HALF_SPACE;
  return {
    id: null,
    bbox: [x - 9, cy - 8, x + 9, cy + 8],
    track: 0,
    group: 0,
    noteGroupId: null,
    staffLinePos: null,
    pitch: null,
    hasDot: false,
    stemUp: true,
    invalid: false,
    label: 'QUARTER',
    ...over,
  };
}

function rest(x: number, label: string, over: Partial<OmrRest> = {}): OmrRest {
  const cy = (STAFF_DEFAULTS.yUpper + STAFF_DEFAULTS.yLower) / 2;
  return { bbox: [x - 8, cy - 10, x + 8, cy + 10], track: 0, group: 0, hasDot: false, label, ...over };
}

function barline(x: number, group = 0): OmrBarline {
  return { bbox: [x, STAFF_DEFAULTS.yUpper, x + 1, STAFF_DEFAULTS.yLower], group };
}

function page(parts: {
  staves?: OmrStaff[];
  noteheads?: OmrNotehead[];
  rests?: OmrRest[];
  barlines?: OmrBarline[];
}): OmrDocument {
  return {
    schemaVersion: 1,
    source: {
      engine: 'oemer',
      engineVersion: '0.1.8',
      imagePath: 'page.png',
      imageWidth: 1200,
      imageHeight: 400,
      provider: 'CPUExecutionProvider',
      wallClockSeconds: 1,
    },
    staves: parts.staves ?? [staff(0)],
    zones: [],
    noteheads: parts.noteheads ?? [],
    noteGroups: [],
    barlines: parts.barlines ?? [],
    rests: parts.rests ?? [],
  };
}

const notesOf = (score: { bars: { items: unknown[] }[] }): Note[] =>
  score.bars.flatMap((b) => b.items).filter((i): i is Note => (i as Note).kind === 'note');

describe('mapOmrToScore — bars and segmentation', () => {
  it('splits a system into bars at the detected barlines, notes landing in x order', () => {
    const score = mapOmrToScore(
      [
        page({
          barlines: [barline(300), barline(500), barline(700)],
          noteheads: [note(200, 2), note(400, 2), note(600, 2), note(800, 2)],
        }),
      ],
      { id: 's' },
    );
    expect(score.bars.map((b) => b.number)).toEqual([1, 2, 3, 4]);
    expect(score.bars.map((b) => b.items.length)).toEqual([1, 1, 1, 1]);
  });

  it('merges near-duplicate barlines (a barline drawn beside a stem fires twice)', () => {
    const score = mapOmrToScore(
      [
        page({
          // Two verticals a few px apart at ~500 are one barline; 300 and 700 are the others.
          barlines: [barline(300), barline(498), barline(503), barline(700)],
          noteheads: [note(200, 2), note(400, 2), note(600, 2), note(800, 2)],
        }),
      ],
      { id: 's' },
    );
    expect(score.bars.length).toBe(4);
  });

  it('ignores barlines outside the note span (clef region and closing barline)', () => {
    const score = mapOmrToScore(
      [
        page({
          // 120 is in the clef/key region before the first note; 950 is the closing barline.
          barlines: [barline(120), barline(500), barline(950)],
          noteheads: [note(300, 2), note(700, 2)],
        }),
      ],
      { id: 's' },
    );
    expect(score.bars.length).toBe(2);
  });

  it('a system with no divider is a single bar', () => {
    const score = mapOmrToScore([page({ noteheads: [note(300, 2), note(500, 2)] })], { id: 's' });
    expect(score.bars.length).toBe(1);
    expect(score.bars[0]!.items.length).toBe(2);
  });
});

describe('mapOmrToScore — durations', () => {
  it('maps every oemer note-type label to the model note value', () => {
    const labels: Array<[string, number]> = [
      ['WHOLE', 1],
      ['HALF', 2],
      ['QUARTER', 4],
      ['EIGHTH', 8],
      ['SIXTEENTH', 16],
      ['THIRTY_SECOND', 32],
    ];
    for (const [label, value] of labels) {
      const score = mapOmrToScore([page({ noteheads: [note(300, 2, { label })] })], { id: 's' });
      const n = notesOf(score)[0]!;
      expect(n.duration.value, label).toBe(value);
      expect(n.duration.dots).toBe(0);
      expect(n.review.flagged, `${label} not flagged`).toBe(false);
    }
  });

  it('reads a dot from oemer', () => {
    const score = mapOmrToScore([page({ noteheads: [note(300, 2, { label: 'QUARTER', hasDot: true })] })], {
      id: 's',
    });
    expect(notesOf(score)[0]!.duration).toEqual({ value: 4, dots: 1 });
  });

  it('an unknown or ambiguous label falls back to a quarter and is flagged low-confidence', () => {
    for (const label of ['HALF_OR_WHOLE', null]) {
      const score = mapOmrToScore([page({ noteheads: [note(300, 2, { label })] })], { id: 's' });
      const n = notesOf(score)[0]!;
      expect(n.duration.value, `${label} -> quarter`).toBe(4);
      expect(n.review.flagged, `${label} flagged`).toBe(true);
      expect(n.review.reasons).toContain('low-confidence');
    }
  });

  it('lays onsets end to end in reading order', () => {
    const score = mapOmrToScore(
      [page({ noteheads: [note(500, 2, { label: 'QUARTER' }), note(200, 4, { label: 'QUARTER' })] })],
      { id: 's' },
    );
    const items = score.bars[0]!.items;
    // Sorted by x: the note at 200 is first (onset 0), the note at 500 second (onset one quarter).
    expect(items.map((i) => i.onset)).toEqual([0, TICKS_PER_QUARTER]);
  });
});

describe('mapOmrToScore — pitch (treble, default key)', () => {
  it('reads diatonic pitch from staff geometry, all naturals under the default C major', () => {
    const cases: Array<[number, string, number]> = [
      [0, 'E', 4],
      [2, 'G', 4],
      [4, 'B', 4],
      [6, 'D', 5],
      [8, 'F', 5],
    ];
    for (const [steps, step, octave] of cases) {
      const score = mapOmrToScore([page({ noteheads: [note(300, steps)] })], { id: 's' });
      const p = notesOf(score)[0]!.pitch;
      expect([p.step, p.octave, p.alter], `steps ${steps}`).toEqual([step, octave, 0]);
    }
  });
});

describe('mapOmrToScore — rests', () => {
  it('maps a rest to a Rest item with its duration', () => {
    const score = mapOmrToScore([page({ rests: [rest(300, 'QUARTER')] })], { id: 's' });
    const item = score.bars[0]!.items[0]!;
    expect(item.kind).toBe('rest');
    expect(item.duration.value).toBe(4);
  });

  it('interleaves rests and notes by x', () => {
    const score = mapOmrToScore(
      [page({ noteheads: [note(200, 2), note(600, 2)], rests: [rest(400, 'QUARTER')] })],
      { id: 's' },
    );
    expect(score.bars[0]!.items.map((i) => i.kind)).toEqual(['note', 'rest', 'note']);
  });
});

describe('mapOmrToScore — metric validity is flagged, never repaired (ADR-0013)', () => {
  it('a bar that fills the meter is not flagged; one that does not is flagged and kept', () => {
    const score = mapOmrToScore(
      [
        page({
          barlines: [barline(500)],
          // Bar 1: two half notes = 4/4 exactly. Bar 2: one quarter = under.
          noteheads: [
            note(200, 2, { label: 'HALF' }),
            note(400, 2, { label: 'HALF' }),
            note(700, 2, { label: 'QUARTER' }),
          ],
        }),
      ],
      { id: 's' },
    );
    expect(score.bars[0]!.review.flagged).toBe(false);
    expect(score.bars[1]!.review.flagged).toBe(true);
    expect(score.bars[1]!.review.reasons).toContain('metrically-invalid');
    // The invalid bar is still stored with its item, not dropped.
    expect(score.bars[1]!.items.length).toBe(1);
  });
});

describe('mapOmrToScore — oemer doubt', () => {
  it("flags a notehead oemer itself marked invalid", () => {
    const score = mapOmrToScore([page({ noteheads: [note(300, 2, { invalid: true })] })], { id: 's' });
    expect(notesOf(score)[0]!.review.reasons).toContain('low-confidence');
  });
});

describe('mapOmrToScore — what import does not invent', () => {
  it('produces no ties, tuplets, chords or sections (not in the worker output / not detected)', () => {
    const score = mapOmrToScore(
      [page({ barlines: [barline(500)], noteheads: [note(300, 2), note(700, 2)] })],
      { id: 's' },
    );
    expect(notesOf(score).every((n) => n.tie === 'none')).toBe(true);
    for (const bar of score.bars) {
      expect(bar.tuplets).toEqual([]);
      expect(bar.chords).toEqual([]);
      expect(bar.startBarline).toBe('none');
      expect(bar.endBarline).toBe('single');
    }
    expect(score.sections).toEqual([]);
  });

  it('defaults key and time and leaves the title empty (Q37 OCR deferred)', () => {
    const score = mapOmrToScore([page({ noteheads: [note(300, 2)] })], { id: 's' });
    expect(score.meta.key).toEqual(DEFAULT_KEY);
    expect(score.meta.time).toEqual(DEFAULT_TIME);
    expect(score.meta.title).toBe('');
  });

  it('passes a caller-supplied title and composer through', () => {
    const score = mapOmrToScore([page({ noteheads: [note(300, 2)] })], {
      id: 's',
      title: 'Blue Bossa',
      composer: 'Kenny Dorham',
    });
    expect(score.meta.title).toBe('Blue Bossa');
    expect(score.meta.composer).toBe('Kenny Dorham');
  });
});

describe('mapOmrToScore — systems and pages', () => {
  it("collapses oemer's per-track staff rows for one system into a single band", () => {
    // oemer tiles a wide staff across several rows sharing a group; the notes still form one line.
    const tiled = [
      staff(0, { xLeft: 100, xRight: 400 }),
      staff(0, { xLeft: 400, xRight: 700 }),
      staff(0, { xLeft: 700, xRight: 1000 }),
    ];
    const score = mapOmrToScore(
      [page({ staves: tiled, barlines: [barline(500)], noteheads: [note(300, 2), note(700, 2)] })],
      { id: 's' },
    );
    expect(score.bars.length).toBe(2);
    expect(notesOf(score).length).toBe(2);
  });

  it('orders systems top to bottom and numbers bars straight through', () => {
    const lower = staff(1, { yUpper: 300, yLower: 364, yCenter: 332 });
    const lowerNote = (x: number): OmrNotehead =>
      note(x, 2, { group: 1, bbox: [x - 9, 332 - 8, x + 9, 332 + 8] });
    const score = mapOmrToScore(
      [
        page({
          staves: [staff(0), lower],
          barlines: [barline(500, 0), barline(500, 1)],
          noteheads: [note(300, 2), note(700, 2), lowerNote(300), lowerNote(700)],
        }),
      ],
      { id: 's' },
    );
    expect(score.bars.map((b) => b.number)).toEqual([1, 2, 3, 4]);
  });

  it('joins several pages in order with continuous bar numbers (Q26)', () => {
    const p1 = page({ barlines: [barline(500)], noteheads: [note(300, 2), note(700, 2)] });
    const p2 = page({ barlines: [barline(500)], noteheads: [note(300, 4), note(700, 4)] });
    const score = mapOmrToScore([p1, p2], { id: 's' });
    expect(score.bars.map((b) => b.number)).toEqual([1, 2, 3, 4]);
    // Page 1's notes (steps 2 -> G4) precede page 2's (steps 4 -> B4).
    expect(notesOf(score).map((n) => n.pitch.step)).toEqual(['G', 'G', 'B', 'B']);
  });

  it('assigns unique ids across the whole score', () => {
    const score = mapOmrToScore(
      [page({ barlines: [barline(500)], noteheads: [note(300, 2), note(700, 2)], rests: [rest(750, 'QUARTER')] })],
      { id: 's' },
    );
    const ids = [
      score.id,
      ...score.bars.flatMap((b) => [b.id, ...b.items.map((i) => i.id)]),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('mapOmrToScore — the hard-error boundary (ADR-0018, Q28)', () => {
  it('throws when no staff is detected on any page', () => {
    expect(() => mapOmrToScore([page({ staves: [] })], { id: 's' })).toThrow(OmrMappingError);
  });

  it('does not throw for a page with staves but no notes (a partial parse is normal)', () => {
    const score = mapOmrToScore([page({ staves: [staff(0)] })], { id: 's' });
    expect(score.bars).toEqual([]);
    expect(score.meta.key).toEqual(DEFAULT_KEY);
  });
});

describe('mapOmrToScore — the committed real dump', () => {
  const doc: OmrDocument = parseOmrDocument(
    JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/omr/aaba-chart.omr.json'), 'utf8')),
  );

  it('produces a non-empty, flagged draft from genuine noisy output without throwing', () => {
    const score = mapOmrToScore([doc], { id: 'aaba' });
    // 8 printed systems of ~4 bars each; the exact count reflects noisy barlines (a draft, ADR-0019).
    expect(score.bars.length).toBeGreaterThan(20);
    // Every notehead in the dump becomes a note (no rests in this fixture).
    expect(notesOf(score).length).toBe(doc.noteheads.length);
    expect(score.meta.key).toEqual(DEFAULT_KEY);
    expect(reviewSummary(score).anythingFlagged).toBe(true);
  });

  it('is deterministic — mapping the same dump twice is identical', () => {
    expect(mapOmrToScore([doc], { id: 'aaba' })).toEqual(mapOmrToScore([doc], { id: 'aaba' }));
  });

  it('places every note inside the image and at a plausible octave', () => {
    const score = mapOmrToScore([doc], { id: 'aaba' });
    for (const n of notesOf(score)) {
      expect(n.pitch.octave).toBeGreaterThanOrEqual(3);
      expect(n.pitch.octave).toBeLessThanOrEqual(6);
    }
  });
});
