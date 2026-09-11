/**
 * The OMR worker's output schema — the contract the Python worker conforms to.
 *
 * ADR-0005 puts the model in TypeScript and the OMR engine in Python, and says the worker
 * "must conform to the model's JSON schema, defined once in TypeScript". This is that
 * schema. The worker (V9's spike, and the real worker from V10) emits JSON in this shape;
 * this file is where the shape is decided and validated, so the two surfaces of the
 * language boundary cannot drift silently.
 *
 * This is deliberately NOT the score model (`score.ts`). It is the raw, pre-interpretation
 * output of optical recognition: detected objects with **pixel coordinates**, before any
 * of it becomes a `Score`. Coordinates are the whole reason oemer was chosen over an
 * engine that only emits MusicXML (ADR-0010, ADR-0023) — stage 3 of the import pipeline
 * aligns chord bounding boxes to note and barline pixel X-coordinates — so a coordinate is
 * a required field here, not an optional extra.
 *
 * Framework-free, Node-free plain TypeScript, like the rest of `model` (ADR-0005).
 */

/** Bumped by any change to this shape; the worker echoes it in `schemaVersion`. */
export const OMR_SCHEMA_VERSION = 1;

/** A pixel bounding box, `[x1, y1, x2, y2]`, in the document's coordinate space. */
export type BBox = [number, number, number, number];

/**
 * Where the coordinates live. oemer normalises the input to ~3.67 megapixels and deskews
 * it before recognising, so coordinates are in that resized, dewarped space rather than
 * the original photo's pixel grid. `imageWidth`/`imageHeight` are the bounds of THAT space,
 * so every coordinate in the document is consistent with them. Stage 3 works within the
 * same space, so this is a fact to record, not a conversion to perform here.
 */
export interface OmrSource {
  /** The recognition engine. `oemer` for both milestones (ADR-0010). */
  engine: string;
  /** The exact pinned engine version (ADR-0023 pins it to catch silent breakage). */
  engineVersion: string;
  /** Basename of the source image, for provenance. */
  imagePath: string;
  /** Width of the coordinate space — the bound every `x` is inside. */
  imageWidth: number;
  /** Height of the coordinate space — the bound every `y` is inside. */
  imageHeight: number;
  /** The onnxruntime execution provider used. CPU is the floor (ADR-0025). */
  provider: string;
  /** CPU wall-clock for the recognition run, in seconds — the ADR-0025 measurement. */
  wallClockSeconds: number;
}

/**
 * One five-line staff. A lead sheet has one per system (ADR-0021), but the schema does
 * not assume that. `track` indexes the staff within its system and `group` the system;
 * a notehead names the same pair, which is how a note is tied to its staff.
 */
export interface OmrStaff {
  index: number;
  track: number | null;
  group: number | null;
  xLeft: number;
  xRight: number;
  yUpper: number;
  yLower: number;
  yCenter: number;
  /** oemer's staff-space estimate (line spacing), if it computed one. */
  unitSize: number | null;
}

export interface OmrNotehead {
  id: number | null;
  bbox: BBox;
  track: number | null;
  group: number | null;
  /** The `id` of the note group this head belongs to, if grouped. */
  noteGroupId: number | null;
  /** Vertical position on the staff, in half-line steps — oemer's own measure. */
  staffLinePos: number | null;
  /** oemer's raw pitch estimate; interpretation is the importer's job, not the worker's. */
  pitch: number | null;
  hasDot: boolean;
  stemUp: boolean | null;
  /** oemer's own "may be a false positive" flag; kept, not filtered, so the importer decides. */
  invalid: boolean;
  /** oemer's note-type label (e.g. `HALF_OR_WHOLE`, `QUARTER`), if assigned. */
  label: string | null;
}

export interface OmrNoteGroup {
  id: number | null;
  bbox: BBox;
  track: number | null;
  group: number | null;
  noteIds: number[];
  stemUp: boolean | null;
  hasStem: boolean | null;
}

export interface OmrBarline {
  bbox: BBox;
  group: number | null;
}

export interface OmrRest {
  bbox: BBox;
  track: number | null;
  group: number | null;
  hasDot: boolean | null;
  /** oemer's rest-type label (e.g. `QUARTER`, `EIGHTH`), if assigned. */
  label: string | null;
}

export interface OmrDocument {
  schemaVersion: number;
  source: OmrSource;
  staves: OmrStaff[];
  /** Per-system vertical bands `[yMin, yMax]`, oemer's own zoning of the page. */
  zones: Array<[number, number]>;
  noteheads: OmrNotehead[];
  noteGroups: OmrNoteGroup[];
  barlines: OmrBarline[];
  rests: OmrRest[];
}

/** Thrown by {@link parseOmrDocument} when the input does not conform. */
export class OmrSchemaError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`OMR document does not conform to the schema: ${problems.join('; ')}`);
    this.name = 'OmrSchemaError';
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Validation
//
// Hand-rolled, in the style of `migrate.ts`'s `assertScoreShape`: collect every problem
// and report them together, rather than pull in a runtime schema library the rest of the
// package does without. This validates structure and the coordinate invariants that make
// the document *usable* — a bbox is four numbers, not null — so a malformed worker output
// fails at the boundary instead of three layers deep wearing a type it does not deserve.
// ---------------------------------------------------------------------------

/**
 * Validate an unknown value as an {@link OmrDocument}, returning it typed. Throws
 * {@link OmrSchemaError} listing every problem found. This is the fast, total check the
 * V9 test plan's "conforms to the worker output schema" clause names.
 */
export function parseOmrDocument(raw: unknown): OmrDocument {
  const problems: string[] = [];
  const doc = raw as Record<string, unknown>;

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new OmrSchemaError([`not an object: ${describe(raw)}`]);
  }

  if (doc.schemaVersion !== OMR_SCHEMA_VERSION) {
    const found = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : describe(doc.schemaVersion);
    problems.push(`schemaVersion is ${found}, expected ${OMR_SCHEMA_VERSION}`);
  }
  checkSource(doc.source, problems);

  checkArray(doc.staves, 'staves', problems, (s, at) => checkStaff(s, at, problems));
  checkArray(doc.zones, 'zones', problems, (z, at) => checkZone(z, at, problems));
  checkArray(doc.noteheads, 'noteheads', problems, (n, at) => checkNotehead(n, at, problems));
  checkArray(doc.noteGroups, 'noteGroups', problems, (g, at) => checkNoteGroup(g, at, problems));
  checkArray(doc.barlines, 'barlines', problems, (b, at) => checkBarline(b, at, problems));
  checkArray(doc.rests, 'rests', problems, (r, at) => checkRest(r, at, problems));

  if (problems.length > 0) throw new OmrSchemaError(problems);
  return raw as OmrDocument;
}

function checkSource(value: unknown, problems: string[]): void {
  if (typeof value !== 'object' || value === null) {
    problems.push('source is missing');
    return;
  }
  const s = value as Record<string, unknown>;
  for (const key of ['engine', 'engineVersion', 'imagePath', 'provider'] as const) {
    if (typeof s[key] !== 'string') problems.push(`source.${key} is not a string`);
  }
  for (const key of ['imageWidth', 'imageHeight', 'wallClockSeconds'] as const) {
    if (!isFiniteNumber(s[key])) problems.push(`source.${key} is not a number`);
  }
  if (isFiniteNumber(s.imageWidth) && (s.imageWidth as number) <= 0) {
    problems.push('source.imageWidth is not positive');
  }
  if (isFiniteNumber(s.imageHeight) && (s.imageHeight as number) <= 0) {
    problems.push('source.imageHeight is not positive');
  }
}

function checkStaff(value: unknown, at: string, problems: string[]): void {
  const s = asObject(value, at, problems);
  if (s === undefined) return;
  if (!isFiniteNumber(s.index)) problems.push(`${at}.index is not a number`);
  for (const key of ['xLeft', 'xRight', 'yUpper', 'yLower', 'yCenter'] as const) {
    if (!isFiniteNumber(s[key])) problems.push(`${at}.${key} is not a number`);
  }
  checkNullableNumber(s.track, `${at}.track`, problems);
  checkNullableNumber(s.group, `${at}.group`, problems);
  checkNullableNumber(s.unitSize, `${at}.unitSize`, problems);
}

function checkZone(value: unknown, at: string, problems: string[]): void {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(isFiniteNumber)) {
    problems.push(`${at} is not a [yMin, yMax] pair`);
  }
}

function checkNotehead(value: unknown, at: string, problems: string[]): void {
  const n = asObject(value, at, problems);
  if (n === undefined) return;
  checkBBox(n.bbox, `${at}.bbox`, problems);
  checkNullableNumber(n.id, `${at}.id`, problems);
  checkNullableNumber(n.track, `${at}.track`, problems);
  checkNullableNumber(n.group, `${at}.group`, problems);
  checkNullableNumber(n.noteGroupId, `${at}.noteGroupId`, problems);
  checkNullableNumber(n.staffLinePos, `${at}.staffLinePos`, problems);
  checkNullableNumber(n.pitch, `${at}.pitch`, problems);
  if (typeof n.hasDot !== 'boolean') problems.push(`${at}.hasDot is not a boolean`);
  if (typeof n.invalid !== 'boolean') problems.push(`${at}.invalid is not a boolean`);
  checkNullableBoolean(n.stemUp, `${at}.stemUp`, problems);
  checkNullableString(n.label, `${at}.label`, problems);
}

function checkNoteGroup(value: unknown, at: string, problems: string[]): void {
  const g = asObject(value, at, problems);
  if (g === undefined) return;
  checkBBox(g.bbox, `${at}.bbox`, problems);
  checkNullableNumber(g.id, `${at}.id`, problems);
  checkNullableNumber(g.track, `${at}.track`, problems);
  checkNullableNumber(g.group, `${at}.group`, problems);
  checkNullableBoolean(g.stemUp, `${at}.stemUp`, problems);
  checkNullableBoolean(g.hasStem, `${at}.hasStem`, problems);
  if (!Array.isArray(g.noteIds) || !g.noteIds.every(isFiniteNumber)) {
    problems.push(`${at}.noteIds is not an array of numbers`);
  }
}

function checkBarline(value: unknown, at: string, problems: string[]): void {
  const b = asObject(value, at, problems);
  if (b === undefined) return;
  checkBBox(b.bbox, `${at}.bbox`, problems);
  checkNullableNumber(b.group, `${at}.group`, problems);
}

function checkRest(value: unknown, at: string, problems: string[]): void {
  const r = asObject(value, at, problems);
  if (r === undefined) return;
  checkBBox(r.bbox, `${at}.bbox`, problems);
  checkNullableNumber(r.track, `${at}.track`, problems);
  checkNullableNumber(r.group, `${at}.group`, problems);
  checkNullableBoolean(r.hasDot, `${at}.hasDot`, problems);
  checkNullableString(r.label, `${at}.label`, problems);
}

// --- primitives ---

function checkBBox(value: unknown, at: string, problems: string[]): void {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(isFiniteNumber)) {
    problems.push(`${at} is not [x1, y1, x2, y2] of numbers`);
    return;
  }
  const [x1, y1, x2, y2] = value as [number, number, number, number];
  if (x1 < 0 || y1 < 0 || x2 < 0 || y2 < 0) problems.push(`${at} has a negative coordinate`);
  if (x2 < x1 || y2 < y1) problems.push(`${at} is inside-out (x2<x1 or y2<y1)`);
}

function checkArray(
  value: unknown,
  name: string,
  problems: string[],
  each: (item: unknown, at: string) => void,
): void {
  if (!Array.isArray(value)) {
    problems.push(`${name} is not an array`);
    return;
  }
  value.forEach((item, i) => each(item, `${name}[${i}]`));
}

function asObject(
  value: unknown,
  at: string,
  problems: string[],
): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push(`${at} is not an object`);
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function checkNullableNumber(value: unknown, at: string, problems: string[]): void {
  if (value !== null && !isFiniteNumber(value)) problems.push(`${at} is not a number or null`);
}

function checkNullableBoolean(value: unknown, at: string, problems: string[]): void {
  if (value !== null && typeof value !== 'boolean') problems.push(`${at} is not a boolean or null`);
}

function checkNullableString(value: unknown, at: string, problems: string[]): void {
  if (value !== null && typeof value !== 'string') problems.push(`${at} is not a string or null`);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}
