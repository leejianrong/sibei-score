import {
  AddressError,
  INSTRUMENT_PRESETS,
  PAGE_LIMITS_MM,
  MAX_SETUP_INSTRUMENTS,
  MAX_VOICES,
  allStaves,
  planSetup,
  emptyVoice,
  nextId,
  parseAddress,
  resolvePart,
  resolveStaff,
  resolveStaffBar,
  staffHoldsNotation,
  voiceHoldsNotation,
  voiceIndexes,
} from '@sibei/model';
import type { Clef, Id, PagePrefs, Part, PartSetup, Score, Spanner, Staff, StaffBar, StaffType } from '@sibei/model';
import { OperationError } from './errors.js';
import type {
  ClefSetPayload,
  InstrumentSetPayload,
  PageSetPayload,
  PartAddPayload,
  PartRmPayload,
  StaffAddPayload,
  StaffRmPayload,
  VoiceAddPayload,
  VoiceRmPayload,
} from './operations.js';
import type { Applied } from './apply.js';

/**
 * Parts, staves and voices (ADR-0041 section 2, SIB2-226). Pure `(score, payload) -> Applied`, like the rest of
 * the applier, and every id or index the applier chooses is written back into the payload so replay (and undo,
 * which is replay) reproduces it exactly.
 *
 * Two rules recur. **Removing something that holds notation is refused unless `force` is true**, the way `bar.rm`
 * refuses a bar with content: undo is there, but a caller who did not mean to lose music should be told. And **a
 * score always keeps one part, one staff and voice 1**: the lead-sheet view and every old address lean on them.
 */

const STAFF_TYPES: readonly StaffType[] = ['standard', 'percussion', 'tab'];
const CLEFS: readonly Clef[] = ['treble', 'bass', 'alto', 'tenor', 'percussion'];

function fail(detail: string): never {
  throw new OperationError({ kind: 'validation', detail });
}

function validStaffType(value: unknown): StaffType {
  if (typeof value === 'string' && (STAFF_TYPES as readonly string[]).includes(value)) return value as StaffType;
  return fail(`a staff type is one of ${STAFF_TYPES.join(', ')}, not ${JSON.stringify(value)}`);
}

function validClef(value: unknown): Clef {
  if (typeof value === 'string' && (CLEFS as readonly string[]).includes(value)) return value as Clef;
  return fail(`a clef is one of ${CLEFS.join(', ')}, not ${JSON.stringify(value)}`);
}

function validProgram(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 127) return value;
  return fail(`an instrument is a General MIDI program from 0 to 127, or null, not ${JSON.stringify(value)}`);
}

function validTransposition(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= -48 && value <= 48) return value;
  return fail(`a transposition is a whole number of semitones from -48 to 48, not ${JSON.stringify(value)}`);
}

function validName(value: unknown): string {
  if (typeof value === 'string') return value;
  return fail(`a name is text, not ${JSON.stringify(value)}`);
}

function defaultClef(type: StaffType): Clef {
  return type === 'percussion' ? 'percussion' : 'treble';
}

function newStaff(score: Score, id: Id, type: StaffType, clef: Clef): Staff {
  return {
    id,
    type,
    clef,
    bars: score.bars.map((bar): StaffBar => ({ barId: bar.id, voices: [emptyVoice()] })),
  };
}

/** The note and tuplet ids held by a staff (every voice) or by one voice, for dropping the spanners that name them. */
function contentIds(staff: Staff, voice?: number): Set<Id> {
  const ids = new Set<Id>();
  for (const staffBar of staff.bars) {
    for (const v of staffBar.voices) {
      if (voice !== undefined && v.index !== voice) continue;
      for (const item of v.items) ids.add(item.id);
    }
  }
  return ids;
}

function withoutSpannersOn(score: Score, ids: ReadonlySet<Id>): Score {
  if (score.spanners === undefined || ids.size === 0) return score;
  const kept = score.spanners.filter((s: Spanner) => !ids.has(s.startId) && !ids.has(s.endId));
  if (kept.length === score.spanners.length) return score;
  const { spanners: _gone, ...rest } = score;
  return kept.length === 0 ? rest : { ...rest, spanners: kept };
}

function refuseUnlessForced(what: string, holds: boolean, force: unknown, how: string): void {
  if (force !== undefined && typeof force !== 'boolean') fail('force is true or false');
  if (holds && force !== true) {
    fail(`${what} holds notes or rests; clear it first, or pass force to remove it with its music (${how})`);
  }
}

// ---------------------------------------------------------------------------
// part.add, part.rm
// ---------------------------------------------------------------------------

export function addPart(score: Score, payload: PartAddPayload = {}): Applied {
  const type = payload.staffType === undefined ? 'standard' : validStaffType(payload.staffType);
  const clef = payload.clef === undefined ? defaultClef(type) : validClef(payload.clef);
  const id = payload.id ?? nextId(score, 'part');
  const staffId = payload.staffId ?? nextId(score, 'staff');
  const part: Part = {
    id,
    name: payload.name === undefined ? '' : validName(payload.name),
    ...(payload.shortName === undefined || payload.shortName === '' ? {} : { shortName: validName(payload.shortName) }),
    instrument: payload.instrument === undefined ? null : validProgram(payload.instrument),
    transposition: payload.transposition === undefined ? 0 : validTransposition(payload.transposition),
    staves: [newStaff(score, staffId, type, clef)],
  };
  return {
    score: { ...score, parts: [...score.parts, part] },
    operation: { type: 'part.add', payload: { ...payload, id, staffId } },
    changed: [id, staffId],
  };
}

export function removePart(score: Score, target: string, payload: PartRmPayload = {}): Applied {
  const { part } = resolvePart(score, target);
  if (score.parts.length === 1) fail('a score needs at least one part');
  refuseUnlessForced(`part ${part.id}`, part.staves.some((staff) => staffHoldsNotation(staff)), payload.force, 'part rm --force');
  const ids = new Set<Id>();
  for (const staff of part.staves) for (const id of contentIds(staff)) ids.add(id);
  const next = withoutSpannersOn({ ...score, parts: score.parts.filter((p) => p.id !== part.id) }, ids);
  return {
    score: next,
    operation: { type: 'part.rm', target, ...(payload.force === undefined ? {} : { payload }) },
    changed: [part.id, ...part.staves.map((staff) => staff.id)],
  };
}

// ---------------------------------------------------------------------------
// staff.add, staff.rm
// ---------------------------------------------------------------------------

export function addStaff(score: Score, target: string | undefined, payload: StaffAddPayload = {}): Applied {
  const part = target === undefined ? score.parts[score.parts.length - 1] : resolvePart(score, target).part;
  if (part === undefined) return fail('a score with no parts cannot take a staff; add a part first');
  const type = payload.type === undefined ? 'standard' : validStaffType(payload.type);
  const clef = payload.clef === undefined ? defaultClef(type) : validClef(payload.clef);
  const id = payload.id ?? nextId(score, 'staff');
  const staff = newStaff(score, id, type, clef);
  return {
    score: {
      ...score,
      parts: score.parts.map((p) => (p.id === part.id ? { ...p, staves: [...p.staves, staff] } : p)),
    },
    operation: { type: 'staff.add', ...(target === undefined ? {} : { target }), payload: { ...payload, id } },
    changed: [id],
  };
}

export function removeStaff(score: Score, target: string, payload: StaffRmPayload = {}): Applied {
  const { staff } = resolveStaff(score, target);
  if (allStaves(score).length === 1) fail('a score needs at least one staff');
  const owner = score.parts.find((part) => part.staves.some((s) => s.id === staff.id))!;
  if (owner.staves.length === 1) fail(`${staff.id} is the only staff of part ${owner.id}; remove the part instead (part rm)`);
  refuseUnlessForced(`staff ${staff.id}`, staffHoldsNotation(staff), payload.force, 'staff rm --force');
  const next = withoutSpannersOn(
    {
      ...score,
      parts: score.parts.map((part) =>
        part.id === owner.id ? { ...part, staves: part.staves.filter((s) => s.id !== staff.id) } : part,
      ),
    },
    contentIds(staff),
  );
  return {
    score: next,
    operation: { type: 'staff.rm', target, ...(payload.force === undefined ? {} : { payload }) },
    changed: [staff.id],
  };
}

// ---------------------------------------------------------------------------
// voice.add, voice.rm
// ---------------------------------------------------------------------------

function staffOfTarget(score: Score, target: string | undefined): { staff: Staff; voice?: number } {
  if (target === undefined) {
    const staves = allStaves(score);
    if (staves.length !== 1) {
      fail(`the score has ${staves.length} staves; name one: ${staves.map((_, at) => `s${at + 1}`).join(', ')}`);
    }
    return { staff: staves[0]! };
  }
  return resolveStaff(score, target);
}

function mapStaff(score: Score, staffId: Id, change: (staff: Staff) => Staff): Score {
  return {
    ...score,
    parts: score.parts.map((part) => ({
      ...part,
      staves: part.staves.map((staff) => (staff.id === staffId ? change(staff) : staff)),
    })),
  };
}

export function addVoice(score: Score, target: string | undefined, payload: VoiceAddPayload = {}): Applied {
  const { staff } = staffOfTarget(score, target);
  const present = voiceIndexes(staff);
  let index = payload.index;
  if (index === undefined) {
    index = Array.from({ length: MAX_VOICES }, (_, at) => at + 1).find((candidate) => !present.includes(candidate));
    if (index === undefined) fail(`staff ${staff.id} already has ${MAX_VOICES} voices, the most a staff takes`);
  }
  if (!Number.isInteger(index) || index < 2 || index > MAX_VOICES) fail(`a voice index is 2 to ${MAX_VOICES}`);
  if (present.includes(index)) fail(`staff ${staff.id} already has voice ${index}`);
  const added = index;
  const next = mapStaff(score, staff.id, (s) => ({
    ...s,
    bars: score.bars.map((bar): StaffBar => {
      const had = s.bars.find((staffBar) => staffBar.barId === bar.id) ?? { barId: bar.id, voices: [emptyVoice()] };
      return { ...had, voices: [...had.voices, emptyVoice(added)].sort((a, b) => a.index - b.index) };
    }),
  }));
  return {
    score: next,
    operation: { type: 'voice.add', ...(target === undefined ? {} : { target }), payload: { ...payload, index } },
    changed: [staff.id],
  };
}

export function removeVoice(score: Score, target: string, payload: VoiceRmPayload = {}): Applied {
  const resolved = resolveStaff(score, target);
  if (resolved.voice === undefined) fail(`name the voice to remove, like ${target}.v2`);
  const index = resolved.voice;
  if (index === 1) fail('voice 1 is every staff\'s own voice and cannot be removed');
  if (!voiceIndexes(resolved.staff).includes(index)) {
    throw new AddressError({
      kind: 'no-such-voice',
      staff: resolved.number,
      voice: index,
      present: voiceIndexes(resolved.staff),
    });
  }
  refuseUnlessForced(`voice ${index} of ${resolved.staff.id}`, voiceHoldsNotation(resolved.staff, index), payload.force, 'voice rm --force');
  const ids = contentIds(resolved.staff, index);
  const next = withoutSpannersOn(
    mapStaff(score, resolved.staff.id, (s) => ({
      ...s,
      bars: s.bars.map((staffBar) => ({ ...staffBar, voices: staffBar.voices.filter((v) => v.index !== index) })),
    })),
    ids,
  );
  return {
    score: next,
    operation: { type: 'voice.rm', target, ...(payload.force === undefined ? {} : { payload }) },
    changed: [resolved.staff.id],
  };
}

// ---------------------------------------------------------------------------
// clef.set, instrument.set
// ---------------------------------------------------------------------------

export function setClef(score: Score, target: string, payload: ClefSetPayload): Applied {
  const parsed = parseAddress(target);
  if (parsed.form === 'staff' && parsed.voice === undefined) {
    const { staff } = resolveStaff(score, target);
    if (payload.clef === null) fail('a staff always has an opening clef; name a bar (s2.bar5) to clear a change');
    const clef = validClef(payload.clef);
    return {
      score: mapStaff(score, staff.id, (s) => ({ ...s, clef })),
      operation: { type: 'clef.set', target, payload: { clef } },
      changed: [staff.id],
    };
  }
  if (parsed.form === 'bar' && parsed.staff !== undefined && parsed.voice === undefined) {
    const { staff, bar } = resolveStaffBar(score, target);
    const clef = payload.clef === null ? null : validClef(payload.clef);
    const next = mapStaff(score, staff.id, (s) => ({
      ...s,
      bars: score.bars.map((gridBar): StaffBar => {
        const had = s.bars.find((staffBar) => staffBar.barId === gridBar.id) ?? { barId: gridBar.id, voices: [emptyVoice()] };
        if (gridBar.id !== bar.id) return had;
        const { clef: _old, ...rest } = had;
        return clef === null ? rest : { ...rest, clef };
      }),
    }));
    return { score: next, operation: { type: 'clef.set', target, payload: { clef } }, changed: [staff.id, bar.id] };
  }
  return fail(`clef set takes a staff (s2) or one staff's bar (s2.bar5), not ${JSON.stringify(target)}`);
}

export function setInstrument(score: Score, target: string | undefined, payload: InstrumentSetPayload): Applied {
  let part: Part;
  if (target === undefined) {
    if (score.parts.length !== 1) {
      fail(`the score has ${score.parts.length} parts; name one: ${score.parts.map((p, at) => `p${at + 1}`).join(', ')}`);
    }
    part = score.parts[0]!;
  } else {
    part = resolvePart(score, target).part;
  }
  const changes: Partial<Part> = {};
  if (payload.name !== undefined) changes.name = validName(payload.name);
  if (payload.instrument !== undefined) changes.instrument = validProgram(payload.instrument);
  if (payload.transposition !== undefined) changes.transposition = validTransposition(payload.transposition);
  const shortName = payload.shortName === undefined ? undefined : payload.shortName === null || payload.shortName === '' ? null : validName(payload.shortName);
  if (Object.keys(changes).length === 0 && shortName === undefined) {
    fail('instrument set needs at least one of name, shortName, instrument, transposition');
  }
  return {
    score: {
      ...score,
      parts: score.parts.map((p) => {
        if (p.id !== part.id) return p;
        const { shortName: _old, ...rest } = p;
        const kept = shortName === undefined ? (p.shortName === undefined ? {} : { shortName: p.shortName }) : shortName === null ? {} : { shortName };
        return { ...rest, ...kept, ...changes };
      }),
    },
    operation: { type: 'instrument.set', ...(target === undefined ? {} : { target }), payload },
    changed: [part.id],
  };
}

// ---------------------------------------------------------------------------
// score.create with instruments (SIB2-288)
// ---------------------------------------------------------------------------

/**
 * The parts a `score.create` starts from: the recorded `parts` on replay, else the presets `instruments` names, or
 * undefined for the plain lead sheet. An unknown preset is refused with the list of known ones.
 */
export function plannedSetup(payload: { instruments?: unknown; parts?: unknown }): PartSetup[] | undefined {
  if (payload.parts !== undefined) {
    if (!Array.isArray(payload.parts) || payload.parts.length === 0) fail('parts is a list of at least one part');
    return payload.parts as PartSetup[];
  }
  if (payload.instruments === undefined) return undefined;
  const ids = payload.instruments;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) fail('instruments is a list of preset names');
  if (ids.length === 0) return undefined;
  if (ids.length > MAX_SETUP_INSTRUMENTS) fail(`a new chart starts with at most ${MAX_SETUP_INSTRUMENTS} instruments`);
  const planned = planSetup(ids as string[]);
  if (!planned.ok) {
    fail(`unknown instrument ${JSON.stringify(planned.unknown)}; the presets are ${INSTRUMENT_PRESETS.map((preset) => preset.id).join(', ')}`);
  }
  return planned.parts;
}

/**
 * Put a setup onto a freshly made score: its parts (each staff empty in every bar), instrument names on when any part
 * has one, and `layout: 'score'` when there is more than one staff. One part, one staff and no name is left as it was.
 */
export function withSetup(score: Score, setup: readonly PartSetup[]): Score {
  const parts = setup.map((part): Part => {
    if (!Array.isArray(part.staves) || part.staves.length === 0) fail('every part of a setup needs a staff');
    return {
      id: part.id,
      name: validName(part.name),
      ...(part.shortName === undefined || part.shortName === '' ? {} : { shortName: validName(part.shortName) }),
      instrument: validProgram(part.instrument),
      transposition: validTransposition(part.transposition),
      staves: part.staves.map((staff) => newStaff(score, staff.id, validStaffType(staff.type), validClef(staff.clef))),
    };
  });
  const staffCount = parts.reduce((sum, part) => sum + part.staves.length, 0);
  const named = parts.some((part) => part.name !== '');
  return {
    ...score,
    parts,
    meta: {
      ...score.meta,
      ...(staffCount > 1 ? { layout: 'score' as const } : {}),
      ...(named ? { showInstrumentNames: true } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// page.set (SIB2-287)
// ---------------------------------------------------------------------------

const PAGE_FIELDS = [
  ['marginTop', 'margin', 'top'],
  ['marginRight', 'margin', 'right'],
  ['marginBottom', 'margin', 'bottom'],
  ['marginLeft', 'margin', 'left'],
  ['staffSize', 'staffSize', null],
  ['systemGap', 'systemGap', null],
] as const;

function validMillimetres(name: string, value: unknown, [low, high]: readonly [number, number]): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) {
    return fail(`${name} is a number of millimetres from ${low} to ${high}, not ${JSON.stringify(value)}`);
  }
  // Tenths of a millimetre: nothing finer is a page setting, and it keeps the stored number short.
  return Math.round(value * 10) / 10;
}

/** Set or clear the page setup fields named; what is left empty is removed, so a cleared chart has no `page` at all. */
export function setPage(score: Score, payload: PageSetPayload): Applied {
  const given = PAGE_FIELDS.filter(([field]) => payload[field] !== undefined);
  if (given.length === 0) fail('page set needs at least one of marginTop, marginRight, marginBottom, marginLeft, staffSize, systemGap');
  const margin: Record<string, number> = { ...score.meta.page?.margin };
  let staffSize = score.meta.page?.staffSize;
  let systemGap = score.meta.page?.systemGap;
  for (const [field, kind, side] of given) {
    const value = payload[field];
    if (kind === 'margin') {
      if (value === null) delete margin[side];
      else margin[side] = validMillimetres(field, value, PAGE_LIMITS_MM.margin);
    } else if (kind === 'staffSize') {
      staffSize = value === null ? undefined : validMillimetres(field, value, PAGE_LIMITS_MM.staffSize);
    } else {
      systemGap = value === null ? undefined : validMillimetres(field, value, PAGE_LIMITS_MM.systemGap);
    }
  }
  const page: PagePrefs = {
    ...(Object.keys(margin).length === 0 ? {} : { margin }),
    ...(staffSize === undefined ? {} : { staffSize }),
    ...(systemGap === undefined ? {} : { systemGap }),
  };
  const { page: _old, ...meta } = score.meta;
  return {
    score: { ...score, meta: Object.keys(page).length === 0 ? meta : { ...meta, page } },
    operation: { type: 'page.set', payload },
    changed: [score.id],
  };
}
