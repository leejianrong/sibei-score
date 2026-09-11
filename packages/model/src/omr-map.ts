import { DEFAULT_KEY, DEFAULT_TIME, makeBar, makeNote, makeRest, makeScore } from './build.js';
import { durationTicks } from './duration.js';
import { barMetrics } from './metrics.js';
import type { OmrBarline, OmrDocument, OmrNotehead, OmrRest, OmrStaff } from './omr.js';
import type {
  Bar,
  BarItem,
  Dots,
  Duration,
  Id,
  NoteValue,
  Pitch,
  Review,
  ReviewReason,
  Score,
  Step,
} from './score.js';

/**
 * Map the OMR worker's raw recognised objects (`OmrDocument`, one per source page) onto a `Score`
 * (V11, R5). This is the interpretation stage the pipeline is built around: the worker recognises
 * pixel objects (ADR-0005, ADR-0010) and this turns them into the editable draft a human corrects
 * (ADR-0019).
 *
 * **Pure, framework-free, Node-free TypeScript**, like the rest of `model` (ADR-0005): it consumes
 * `OmrDocument` (this package's own worker-output schema, `omr.ts`) and produces a `Score` (this
 * package's runtime truth, `score.ts`), so it is fully unit-testable at the fast layer against the
 * committed real dump — no oemer, no weights, no Docker. The runner (`@sibei/api`) calls it and lands
 * the result through the server-only `score.import` op (ADR-0003); nothing here touches the store.
 *
 * ## Every parse is a draft (ADR-0019)
 *
 * OMR is the dominant risk in the product and it will not be perfect. This mapper does not pretend
 * otherwise: it produces a best-effort skeleton and **flags what it is unsure of** rather than
 * guessing silently or refusing. Metrically invalid bars are stored and flagged, never repaired
 * (ADR-0013); a note oemer itself doubts, or whose duration it could not name, is flagged
 * `low-confidence`. The correction experience (V14) is where a human turns this draft into the chart.
 *
 * ## What is derivable from the worker's output today, and what is not
 *
 * The `OmrDocument` schema carries staves, noteheads (with a pixel bbox, a staff position and a
 * note-type label), note groups, single barlines and rests — and nothing else. So this mapper derives
 * exactly that: **the melody (pitch + rhythm), rests, and bar divisions.** Everything the schema does
 * not carry cannot be mapped and is deferred to the human, or to a later slice that extends the worker:
 *
 * - **Clef, key signature and time signature are not in the schema** (the worker computes clef/sfn
 *   layers internally but does not emit them). So the meta defaults to C major / 4-4 — the lead-sheet
 *   default — and pitch is read against a treble clef. Detecting these needs the worker and the schema
 *   extended plus a fresh real fixture, which is deferred (see the V11 write-up in SLICES/history).
 * - **Ties and tuplets/triplets are not in the schema either**, so they are not produced; a tied or
 *   triplet figure imports as its separate notes and the human joins them (ADR-0019 names ties and
 *   triplets as exactly the notation OMR gets least reliably, so hand-correction is the accepted path).
 * - **Barline *type*, sections and rehearsal letters are supported but never detected** (ADR-0021):
 *   import yields single barlines and no sections, and the user adds structure in correction. A freshly
 *   imported chart therefore lays out on a plain four-bar grid until then (ADR-0015, ADR-0021).
 * - **Chord symbols and title/composer OCR are stage-2/3 work** (ADR-0011, ADR-0027): they need OCR
 *   the pipeline does not run until V13, so a V11 draft carries no chords and an empty title.
 */

/** The prefix marking a note/rest/bar built by import — kept `low-confidence` where the parse is unsure. */
const LOW_CONFIDENCE: ReviewReason = 'low-confidence';

export interface OmrMapOptions {
  /** The id the new score is created under (the runner mints it from the job). */
  id: Id;
  /** An optional title. Left empty by default (KAN-594): import does not OCR a title in V11 (Q37). */
  title?: string;
  /** An optional composer, for the same reason. */
  composer?: string;
}

/**
 * Thrown when there is nothing to import: no staff was detected on any page. ADR-0018 draws the line
 * here — a partial parse with flagged gaps is the *normal* outcome (Q28), but an image with no staff
 * at all is a hard error, because the alternative is silently creating an empty score the user then
 * has to notice and delete. The runner turns this into a failed, retryable job (Q80), committing
 * nothing.
 */
export class OmrMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OmrMappingError';
  }
}

/**
 * A staff system, once oemer's repeated per-track staff rows are collapsed into one band (V9
 * finding: `staffs` repeats each system across a track grid the consumer must collapse). One system
 * is one printed line of music; a lead sheet has one staff per system (ADR-0021).
 */
interface System {
  /** The page-local group key oemer tagged this system with, used to attach objects to it. */
  groupKey: number | null;
  xLeft: number;
  xRight: number;
  yUpper: number;
  yLower: number;
  /** Line spacing (one staff space) in pixels; drives pitch geometry. Positive and finite. */
  unitSize: number;
}

/**
 * Map the recognised pages (in page order, Q26) onto one `Score`. The pages join into a single chart:
 * page 1's systems, top to bottom, then page 2's, and so on, with bars numbered straight through.
 */
export function mapOmrToScore(pages: readonly OmrDocument[], options: OmrMapOptions): Score {
  const totalStaves = pages.reduce((sum, page) => sum + page.staves.length, 0);
  if (totalStaves === 0) {
    // ADR-0018 / Q28: no staff anywhere is the one hard error. Everything else is a flagged draft.
    throw new OmrMappingError('no staff was detected in the image, so there is nothing to turn into a chart');
  }

  // Gather bars across every page and system first, then number them straight through and give each
  // object a stable id. Numbering after collection keeps ids and bar numbers continuous across the
  // page break, which is the whole of Q26's "one chart with the pages in order".
  const rawBars: RawBar[] = [];
  for (const page of pages) {
    for (const system of systemsOf(page)) {
      for (const raw of barsOfSystem(system, page)) rawBars.push(raw);
    }
  }

  const bars = rawBars.map((raw, index) => buildBar(raw, index + 1));

  return makeScore({
    id: options.id,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.composer === undefined ? {} : { composer: options.composer }),
    // Clef/key/time are not recognised (see the module header): default them. A human sets the real
    // key and meter in correction, which is cheap and unambiguous next to the source image (ADR-0019).
    key: DEFAULT_KEY,
    time: DEFAULT_TIME,
    bars,
    // Sections are never detected (ADR-0021); the correction view prompts for them (ADR-0019).
    sections: [],
  });
}

// ---------------------------------------------------------------------------
// Systems: collapse oemer's per-track staff grid into one band per printed line
// ---------------------------------------------------------------------------

/**
 * The systems on a page, top to bottom. oemer registers a `Staff` per (system, track) cell and tiles
 * a wide staff across several x-segments, so a single printed line arrives as many `OmrStaff` rows
 * sharing a `group` (V9 finding). We collapse by `group` into one band spanning the union of their
 * extents. `zones` is deliberately ignored: the V9 finding measured it as unreliable/incomplete, so
 * the per-staff extents are the trustworthy source.
 */
function systemsOf(page: OmrDocument): System[] {
  const byGroup = new Map<number | null, OmrStaff[]>();
  for (const staff of page.staves) {
    const key = staff.group;
    const existing = byGroup.get(key);
    if (existing === undefined) byGroup.set(key, [staff]);
    else existing.push(staff);
  }

  const systems: System[] = [];
  for (const [groupKey, staves] of byGroup) {
    const xLeft = Math.min(...staves.map((s) => s.xLeft));
    const xRight = Math.max(...staves.map((s) => s.xRight));
    const yUpper = Math.min(...staves.map((s) => s.yUpper));
    const yLower = Math.max(...staves.map((s) => s.yLower));
    systems.push({ groupKey, xLeft, xRight, yUpper, yLower, unitSize: unitSizeOf(staves, yUpper, yLower) });
  }

  // Top to bottom is reading order for a single-staff lead sheet.
  systems.sort((a, b) => a.yUpper - b.yUpper);
  return systems;
}

/**
 * The line spacing to use for this system, in pixels. oemer's own `unitSize` when it computed one
 * (the median across the collapsed rows, robust to an outlier), else the geometric fallback of the
 * band height over its four inter-line gaps. Always positive so pitch geometry never divides by zero.
 */
function unitSizeOf(staves: OmrStaff[], yUpper: number, yLower: number): number {
  const measured = staves.map((s) => s.unitSize).filter((u): u is number => u !== null && u > 0);
  if (measured.length > 0) return median(measured);
  const span = yLower - yUpper;
  return span > 0 ? span / 4 : 1;
}

// ---------------------------------------------------------------------------
// Bars: segment a system into bars using the detected barlines
// ---------------------------------------------------------------------------

/** A bar before it is numbered and its ids are assigned: its recognised contents in reading order. */
interface RawBar {
  items: RawItem[];
}

/** One recognised event inside a bar: a note or a rest, with the x it was found at and its doubt. */
interface RawItem {
  x: number;
  duration: Duration;
  /** Present for a note, absent for a rest. */
  pitch: Pitch | null;
  /** Whether this event is uncertain enough to flag `low-confidence` (ADR-0019). */
  lowConfidence: boolean;
}

/**
 * Split a system into bars and drop each recognised note and rest into the bar it sits in.
 *
 * Barline detection is oemer's least reliable output (V9: over-fires on stems and accidentals,
 * under-detects on dense pages), so the detected barlines are cleaned before use: near-duplicate
 * verticals are merged, and only those *between* the first and last recognised event count as
 * dividers — a barline in the clef/key region before the first note, or the closing barline after
 * the last, is a boundary of the system, not a divider within it. What remains cuts the system into
 * bars. A system with no usable divider is one bar (a short or dense line oemer split poorly is still
 * a bar the human can split in correction, not a parse failure).
 */
function barsOfSystem(system: System, page: OmrDocument): RawBar[] {
  const items = itemsOfSystem(system, page);

  // No recognised events: emit nothing rather than a spurious empty bar. An empty band between two
  // real systems contributes no bars to the chart.
  if (items.length === 0) return [];

  items.sort((a, b) => a.x - b.x);
  const firstX = items[0]!.x;
  const lastX = items[items.length - 1]!.x;

  const dividers = internalDividers(system, page, firstX, lastX);

  // Boundaries run from the system's left edge, through each internal divider, to its right edge.
  const cuts = [Math.min(system.xLeft, firstX) - 1, ...dividers, Math.max(system.xRight, lastX) + 1];
  const bars: RawBar[] = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const start = cuts[i]!;
    const end = cuts[i + 1]!;
    const inBar = items.filter((item) => item.x >= start && item.x < end);
    // A segment between two dividers that caught no event is a bar the recogniser saw as empty; keep
    // it only if it actually has a divider on both sides (i.e. it is an interior segment), so a wide
    // left margin does not become a phantom leading bar.
    if (inBar.length > 0) bars.push({ items: inBar });
  }
  return bars;
}

/**
 * The x-positions that divide this system into bars: detected barlines, merged and trimmed to the
 * ones that fall strictly between the first and last recognised event.
 */
function internalDividers(system: System, page: OmrDocument, firstX: number, lastX: number): number[] {
  const barlines = page.barlines.filter((b) => attachesTo(system, b.group, centerY(b.bbox)));
  const xs = barlines.map((b) => centerX(b.bbox)).sort((a, b) => a - b);
  // Merge verticals closer than ~1.2 staff spaces: a barline drawn beside a stem or an accidental
  // fires twice, and two "barlines" a few pixels apart are one (V9 finding).
  const merged = mergeClose(xs, Math.max(system.unitSize * 1.2, 6));
  const margin = system.unitSize * 0.5;
  return merged.filter((x) => x > firstX + margin && x < lastX - margin);
}

/** The notes and rests recognised inside a system, as raw bar items (unordered). */
function itemsOfSystem(system: System, page: OmrDocument): RawItem[] {
  const items: RawItem[] = [];
  for (const note of page.noteheads) {
    if (!attachesTo(system, note.group, centerY(note.bbox))) continue;
    items.push(noteItem(note, system));
  }
  for (const rest of page.rests) {
    if (!attachesTo(system, rest.group, centerY(rest.bbox))) continue;
    items.push(restItem(rest));
  }
  return items;
}

/**
 * Whether an object belongs to this system. oemer usually tags an object with the same `group` as
 * its staff, which is the reliable signal; when it is null we fall back to whether the object's
 * vertical centre lands within the system's band (widened by a staff space for ledger notes).
 */
function attachesTo(system: System, group: number | null, objectY: number): boolean {
  if (group !== null && system.groupKey !== null) return group === system.groupKey;
  const pad = system.unitSize * 2;
  return objectY >= system.yUpper - pad && objectY <= system.yLower + pad;
}

// ---------------------------------------------------------------------------
// Notes and rests
// ---------------------------------------------------------------------------

function noteItem(note: OmrNotehead, system: System): RawItem {
  const duration = durationOf(note.label, note.hasDot);
  return {
    x: centerX(note.bbox),
    duration: duration.value,
    pitch: pitchFromGeometry(note, system),
    // Flag when oemer doubts the head, or could not name its duration — the concrete doubts a
    // reviewer should be pointed at (ADR-0019). Pitch is always best-effort but not flagged on its
    // own, or the whole melody would light up and the highlight would stop meaning anything.
    lowConfidence: note.invalid || duration.uncertain,
  };
}

function restItem(rest: OmrRest): RawItem {
  const duration = durationOf(rest.label, rest.hasDot ?? false);
  return {
    x: centerX(rest.bbox),
    duration: duration.value,
    pitch: null,
    lowConfidence: duration.uncertain,
  };
}

/**
 * Turn a note/rest's centre y into a pitch, read against a treble clef (import assumes treble — the
 * clef is not recognised, see the module header). The staff's bottom line is E4 and every half staff
 * space above it is one diatonic step up, so the pitch is the diatonic degree at that height. The
 * default key is C major, so every step is natural; a real key and any accidentals are the human's to
 * add in correction (the accidental *symbols* oemer detects are not in the schema).
 */
function pitchFromGeometry(note: OmrNotehead, system: System): Pitch {
  const halfSpace = system.unitSize / 2;
  const steps = Math.round((system.yLower - centerY(note.bbox)) / halfSpace);
  // E4 is diatonic index 4*7 + 2. Add the steps above the bottom line.
  const diatonic = diatonicIndexOf('E', 4) + steps;
  const step = LETTERS[((diatonic % 7) + 7) % 7]!;
  const octave = Math.floor(diatonic / 7);
  return { step, alter: 0, octave };
}

const LETTERS: readonly Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

function diatonicIndexOf(step: Step, octave: number): number {
  return octave * 7 + LETTERS.indexOf(step);
}

/**
 * Map oemer's note/rest-type label to a model duration. oemer's labels are its `NoteType`/`RestType`
 * enum names. An absent or ambiguous label (oemer emits `HALF_OR_WHOLE` when it cannot tell a hollow
 * head's value) falls back to a quarter and is marked uncertain, so the note is flagged and the bar's
 * metric validity (ADR-0013) points a reviewer at it.
 */
function durationOf(label: string | null, hasDot: boolean): { value: Duration; uncertain: boolean } {
  const dots: Dots = hasDot ? 1 : 0;
  const value = label === null ? null : NOTE_VALUE_OF_LABEL[label] ?? null;
  if (value === null) return { value: { value: 4, dots }, uncertain: true };
  return { value: { value, dots }, uncertain: false };
}

/** oemer NoteType/RestType enum name -> model note value. Shared by notes and rests. */
const NOTE_VALUE_OF_LABEL: Record<string, NoteValue> = {
  WHOLE: 1,
  HALF: 2,
  QUARTER: 4,
  EIGHTH: 8,
  SIXTEENTH: 16,
  THIRTY_SECOND: 32,
};

// ---------------------------------------------------------------------------
// Building the model bar
// ---------------------------------------------------------------------------

/**
 * Build a numbered model bar from a raw one. Onsets are laid end to end from the start of the bar in
 * reading (x) order — the melody is monophonic, so left-to-right is time order. When the durations do
 * not sum to the meter the bar is *still stored*, flagged metrically invalid rather than repaired
 * (ADR-0013): a wrong rhythm is exactly what a human corrects against the source image.
 */
function buildBar(raw: RawBar, number: number): Bar {
  const items: BarItem[] = [];
  let onset = 0;
  let noteOrdinal = 0;
  let restOrdinal = 0;
  for (const item of raw.items) {
    const review = item.lowConfidence ? flagged(LOW_CONFIDENCE) : undefined;
    if (item.pitch === null) {
      restOrdinal += 1;
      items.push(
        makeRest({
          id: `rest-${number}-${restOrdinal}`,
          onset,
          duration: item.duration,
          ...(review === undefined ? {} : { review }),
        }),
      );
    } else {
      noteOrdinal += 1;
      items.push(
        makeNote({
          id: `note-${number}-${noteOrdinal}`,
          onset,
          duration: item.duration,
          pitch: item.pitch,
          ...(review === undefined ? {} : { review }),
        }),
      );
    }
    onset += durationTicks(item.duration);
  }

  const bar = makeBar({ id: `bar-${number}`, number, items });
  // Stamp the bar's own review with the derived metric flag, mirroring what the applier writes on
  // every edit (`review.ts`): readers derive `metrically-invalid` fresh, but storing it keeps an
  // imported document consistent with an authored one.
  const metrics = barMetrics(bar, DEFAULT_TIME);
  if (!metrics.valid) bar.review = flagged('metrically-invalid');
  return bar;
}

function flagged(reason: ReviewReason): Review {
  return { flagged: true, reasons: [reason] };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function centerX(bbox: readonly number[]): number {
  return (bbox[0]! + bbox[2]!) / 2;
}

function centerY(bbox: readonly number[]): number {
  return (bbox[1]! + bbox[3]!) / 2;
}

/** Collapse a sorted list of x-positions, merging any run closer than `threshold` to their mean. */
function mergeClose(sorted: readonly number[], threshold: number): number[] {
  const out: number[] = [];
  let run: number[] = [];
  for (const x of sorted) {
    if (run.length === 0 || x - run[run.length - 1]! <= threshold) {
      run.push(x);
    } else {
      out.push(mean(run));
      run = [x];
    }
  }
  if (run.length > 0) out.push(mean(run));
  return out;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
