import { allStaves, barView, voiceIndexes, type VoiceSelect } from './staves.js';
import { beatOfOnset, onsetOfBeat } from './duration.js';
import { chordTones, samePitch, type ChordTone } from './chord-notes.js';
import { formatPitch, parsePitch } from './pitch.js';
import type { BarView, BarItem, Chord, Id, Note, Part, Rest, Score, Staff } from './score.js';

/**
 * Musical position addresses (ADR-0007). The CLI addresses by position because that is what a
 * human or an agent can read off the page; the model carries stable IDs because those are
 * unambiguous. Both, with different roles, and this file is where the two meet.
 *
 * Resolution lives here — framework-free, no HTTP, no store — so that it happens **server-side
 * and in one place**, and both surfaces get identical semantics *and* identical error messages
 * (PLAN.md). A resolver per surface would be two subtly different resolvers within a month.
 *
 * The rule that makes positions safe is strictness. A position that is not an onset is an
 * error, never a snap to the nearest thing: snapping lets an agent edit the wrong note and
 * never find out, whereas an error listing the bar's real onsets is recoverable. A loud failure
 * beats a silent mis-edit.
 */

/**
 * Which staff and voice an address names (ADR-0041 section 2): `s2` is the second staff of the score in part order,
 * `v2` the second voice of it. Absent means "the only one": it is an error, listing the candidates, when the score
 * has more than one it could mean — never a snap (ADR-0007).
 */
export interface Qualifier {
  staff?: number;
  voice?: number;
}

/** The forms, parsed. A `bar`, `beat` or `ordinal` may carry a staff/voice qualifier (`s2.v2.bar12.n3`). */
export type Address =
  /** `bar12` — a whole bar. Structure attaches here: a section, a barline, an ending (V7). `s2.bar12` is staff 2's bar (a clef change). */
  | ({ form: 'bar'; bar: number } & Qualifier)
  /** `bar12.beat3` — a beat within a bar. 1-based, fractional between beats. */
  | ({ form: 'beat'; bar: number; beat: number; tone?: string } & Qualifier)
  /**
   * `bar12.n3` — the third item in bar 12, ordered by onset then by insertion order. `bar12.n3.Eb5` names one pitch of
   * a stacked chord (ADR-0041 "As built: stacked chords"): by its written pitch, which a chord never holds twice, so it
   * is unambiguous and survives other tones being added or removed.
   */
  | ({ form: 'ordinal'; bar: number; ordinal: number; tone?: string } & Qualifier)
  /** `note-17` — a stable ID. */
  | { form: 'id'; id: Id }
  /** `s2` or `s2.v2` — a staff, or one voice of it, with no bar: what `staff rm`, `voice rm` and `clef set` name. */
  | ({ form: 'staff' } & Qualifier & { staff: number })

/**
 * What the caller is looking for. The CLI verb knows: `note set` wants a note, `chord set`
 * wants a chord. Passing it in is what turns "there is something there but not what you meant"
 * into a precise error instead of a silent mismatch.
 */
export type AddressKind = 'item' | 'note' | 'rest' | 'chord';

export type Addressable = Note | Rest | Chord;

export interface Resolved<T extends Addressable = Addressable> {
  bar: BarView;
  target: T;
  /** Ticks from the start of the bar. */
  onset: number;
  /** The staff and voice the object is in, to hand back to `mapBarView` / `withBarView` when writing it. */
  select: VoiceSelect;
  /** Set when the address named one pitch of a stacked chord (`bar12.n3.Eb5`, or the id of a stack member). */
  tone?: ChordTone;
}

/** Where an address points, whether or not anything is there yet. */
export interface Position {
  bar: BarView;
  onset: number;
  select: VoiceSelect;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Structured rather than a string, because both surfaces render it and an agent branches on
 * it. `formatAddressFailure` is the one place the prose lives.
 */
export type AddressFailure =
  | { kind: 'syntax'; text: string }
  | { kind: 'no-such-bar'; bar: number; present: readonly number[] }
  /** The one the ADR is about: the message lists what *is* there. */
  | {
      kind: 'not-an-onset';
      bar: number;
      beat: number;
      onsets: readonly number[];
      looking: AddressKind;
    }
  | { kind: 'no-such-ordinal'; bar: number; ordinal: number; count: number }
  | { kind: 'no-such-id'; id: Id }
  /** `bar12.n3.Eb5` where the chord has no such pitch; the message lists the ones it has. */
  | { kind: 'no-such-tone'; at: string; pitch: string; present: readonly string[] }
  | { kind: 'wrong-kind'; found: AddressKind; looking: AddressKind; at: string }
  | { kind: 'not-a-position'; text: string }
  /** A bar address given where a note/rest/chord was wanted. */
  | { kind: 'not-an-object'; text: string }
  /** A position or id given where a whole-bar address was wanted (a structure verb). */
  | { kind: 'not-a-bar'; text: string }
  /** More than one staff or voice could be meant (ADR-0041 section 2): the candidates are the qualified spellings. */
  | { kind: 'ambiguous'; text: string; candidates: readonly string[] }
  | { kind: 'no-such-staff'; staff: number; count: number }
  | { kind: 'no-such-voice'; staff: number; voice: number; present: readonly number[] };

export class AddressError extends Error {
  readonly failure: AddressFailure;

  constructor(failure: AddressFailure) {
    super(formatAddressFailure(failure));
    this.name = 'AddressError';
    this.failure = failure;
  }
}

/**
 * The message both surfaces print. An agent that self-corrects needs the error to say what to
 * do next, which for a missed onset means naming the onsets that exist (ADR-0008).
 */
export function formatAddressFailure(failure: AddressFailure): string {
  switch (failure.kind) {
    case 'syntax':
      return (
        `not an address: ${JSON.stringify(failure.text)}. ` +
        `Expected bar12, bar12.beat3, bar12.n3, or an id like note-17; s2.v2.bar12.n3 names a staff and voice.`
      );
    case 'no-such-bar':
      return failure.present.length === 0
        ? `there is no bar ${failure.bar}; the score has no bars yet`
        : `there is no bar ${failure.bar}; bars are ${formatList(failure.present)}`;
    case 'not-an-onset':
      return failure.onsets.length === 0
        ? `bar ${failure.bar} has no ${failure.looking} at beat ${formatBeat(failure.beat)}; the bar is empty`
        : `bar ${failure.bar} has no ${failure.looking} at beat ${formatBeat(failure.beat)}; ` +
            `onsets are ${failure.onsets.map(formatBeat).join(', ')}`;
    case 'no-such-ordinal':
      return failure.count === 0
        ? `bar ${failure.bar} has nothing in it, so there is no n${failure.ordinal}`
        : `bar ${failure.bar} has ${failure.count} ${plural(failure.count, 'item')}, so there is ` +
            `no n${failure.ordinal}`;
    case 'no-such-id':
      return `there is nothing with the id ${JSON.stringify(failure.id)} in this score`;
    case 'no-such-tone':
      return `${failure.at} has no ${failure.pitch}; its pitches are ${failure.present.join(', ')}`;
    case 'wrong-kind':
      return `${failure.at} is ${article(failure.found)}, not ${article(failure.looking)}`;
    case 'not-a-position':
      return (
        `${JSON.stringify(failure.text)} names an object rather than a place. ` +
        `Use a beat address like bar12.beat3 to say where.`
      );
    case 'not-an-object':
      return (
        `${JSON.stringify(failure.text)} names a whole bar rather than a note, rest or chord. ` +
        `Use a beat address like bar12.beat3, or an id.`
      );
    case 'not-a-bar':
      return (
        `${JSON.stringify(failure.text)} names a position rather than a whole bar. ` +
        `Use a bar address like bar12.`
      );
    case 'ambiguous':
      return (
        `${JSON.stringify(failure.text)} could mean more than one thing in a score with several staves or voices; ` +
        `say which: ${failure.candidates.join(', ')}`
      );
    case 'no-such-staff':
      return `there is no staff s${failure.staff}; the score has ${failure.count} ${plural(failure.count, 'staff')}${failure.count === 1 ? '' : ' (s1' + (failure.count > 1 ? `..s${failure.count}` : '') + ')'}`;
    case 'no-such-voice':
      return `staff s${failure.staff} has no voice v${failure.voice}; its voices are ${failure.present.map((v) => `v${v}`).join(', ')}`;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** `bar0` is the pickup, so bar 1 is the first full bar, matching how musicians count. */
const TONE_SUFFIX = '(?:\\.([A-Ga-g](?:#{1,2}|b{1,2})?-?\\d+))?';
const BEAT_FORM = new RegExp(`^bar(\\d+)\\.beat(\\d+(?:\\.\\d+)?)${TONE_SUFFIX}$`);
const ORDINAL_FORM = /^bar(\d+)\.n(\d+)(?:\.([A-Ga-g](?:#{1,2}|b{1,2})?-?\d+))?$/;
const BAR_FORM = /^bar(\d+)$/;
const ID_FORM = /^[a-z]+-\d+$/;

const STAFF_ONLY_FORM = /^s(\d+)(?:\.v(\d+))?$/;
const QUALIFIER_PREFIX = /^(?:s(\d+)\.)?(?:v(\d+)\.)?(?=bar)/;

/** Syntax only — no score consulted, so this cannot tell you whether the thing exists. */
export function parseAddress(text: string): Address {
  const trimmed = text.trim();

  const staffOnly = STAFF_ONLY_FORM.exec(trimmed);
  if (staffOnly !== null) {
    const staff = Number(staffOnly[1]);
    const voice = staffOnly[2] === undefined ? undefined : Number(staffOnly[2]);
    if (staff < 1 || (voice !== undefined && voice < 1)) throw new AddressError({ kind: 'syntax', text });
    return voice === undefined ? { form: 'staff', staff } : { form: 'staff', staff, voice };
  }

  const prefix = QUALIFIER_PREFIX.exec(trimmed);
  const qualifier: Qualifier = {};
  let body = trimmed;
  if (prefix !== null && prefix[0] !== '') {
    if (prefix[1] !== undefined) qualifier.staff = Number(prefix[1]);
    if (prefix[2] !== undefined) qualifier.voice = Number(prefix[2]);
    if ((qualifier.staff ?? 1) < 1 || (qualifier.voice ?? 1) < 1) throw new AddressError({ kind: 'syntax', text });
    body = trimmed.slice(prefix[0].length);
  }

  const ordinal = ORDINAL_FORM.exec(body);
  if (ordinal !== null) {
    const [, bar, n, tone] = ordinal;
    // n0 is not the zeroth item; ordinals are 1-based like everything a musician counts.
    if (Number(n) < 1) throw new AddressError({ kind: 'syntax', text });
    const named = tone === undefined ? {} : { tone: `${tone[0]!.toUpperCase()}${tone.slice(1)}` };
    return { form: 'ordinal', bar: Number(bar), ordinal: Number(n), ...named, ...qualifier };
  }

  const beat = BEAT_FORM.exec(body);
  if (beat !== null) {
    const [, bar, b, tone] = beat;
    if (Number(b) < 1) throw new AddressError({ kind: 'syntax', text });
    const named = tone === undefined ? {} : { tone: `${tone[0]!.toUpperCase()}${tone.slice(1)}` };
    return { form: 'beat', bar: Number(bar), beat: Number(b), ...named, ...qualifier };
  }

  const bar = BAR_FORM.exec(body);
  if (bar !== null) return { form: 'bar', bar: Number(bar[1]), ...qualifier };

  if (body === trimmed && ID_FORM.test(trimmed)) return { form: 'id', id: trimmed };

  throw new AddressError({ kind: 'syntax', text });
}

/** `s2.v2.`, `s2.` or `v2.`: the qualifier as it leads an address. */
export function formatQualifier(q: Qualifier): string {
  return `${q.staff === undefined ? '' : `s${q.staff}.`}${q.voice === undefined ? '' : `v${q.voice}.`}`;
}

/** The address, printed. The text projection prints these, so an agent never constructs one. */
export function formatAddress(address: Address): string {
  switch (address.form) {
    case 'bar':
      return `${formatQualifier(address)}bar${address.bar}`;
    case 'beat':
      return `${formatQualifier(address)}bar${address.bar}.beat${formatBeat(address.beat)}${address.tone === undefined ? '' : `.${address.tone}`}`;
    case 'ordinal':
      return `${formatQualifier(address)}bar${address.bar}.n${address.ordinal}${address.tone === undefined ? '' : `.${address.tone}`}`;
    case 'id':
      return address.id;
    case 'staff':
      return `s${address.staff}${address.voice === undefined ? '' : `.v${address.voice}`}`;
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Which staff and voice an address resolved to, ready for the accessors in `staves.ts`. */
function selectOf(score: Score, address: Address & Qualifier, text: string, strict: boolean): Required<VoiceSelect> | null {
  const staves = allStaves(score);
  // No staff at all is a document the accessors repair on first write; the old default view applies.
  if (staves.length === 0) return null;
  const spell = (staff: number, voice?: number): string =>
    `${formatQualifier({ staff, ...(voice === undefined ? {} : { voice }) })}${unqualified(address)}`;

  let staffNumber: number;
  if (address.staff !== undefined) {
    if (address.staff > staves.length) throw new AddressError({ kind: 'no-such-staff', staff: address.staff, count: staves.length });
    staffNumber = address.staff;
  } else if (staves.length === 1) {
    staffNumber = 1;
  } else {
    if (!strict) return null;
    const candidates = staves.flatMap((staff, at) =>
      voiceIndexes(staff)
        .filter((voice) => address.voice === undefined || voice === address.voice)
        .map((voice) => spell(at + 1, voice)),
    );
    if (candidates.length === 0) {
      throw new AddressError({ kind: 'no-such-voice', staff: 1, voice: address.voice!, present: voiceIndexes(staves[0]!) });
    }
    throw new AddressError({ kind: 'ambiguous', text, candidates });
  }

  const staff = staves[staffNumber - 1]!;
  const voices = voiceIndexes(staff);
  if (address.voice !== undefined) {
    if (!voices.includes(address.voice)) {
      throw new AddressError({ kind: 'no-such-voice', staff: staffNumber, voice: address.voice, present: voices });
    }
    return { staff: staff.id, voice: address.voice };
  }
  if (voices.length === 1) return { staff: staff.id, voice: voices[0]! };
  if (!strict) return null;
  throw new AddressError({ kind: 'ambiguous', text, candidates: voices.map((voice) => spell(staffNumber, voice)) });
}

/** An address without its qualifier, for listing candidates. */
function unqualified(address: Address): string {
  switch (address.form) {
    case 'bar':
      return `bar${address.bar}`;
    case 'beat':
      return `bar${address.bar}.beat${formatBeat(address.beat)}${address.tone === undefined ? '' : `.${address.tone}`}`;
    case 'ordinal':
      return `bar${address.bar}.n${address.ordinal}${address.tone === undefined ? '' : `.${address.tone}`}`;
    default:
      return formatAddress(address);
  }
}

/**
 * The object an address names. Strict: if there is nothing at that position, the error lists
 * the onsets that do exist. In a score with more than one staff or voice an address that does not say which
 * (`bar12.n3`) is an error listing the candidates (ADR-0041); chords live on the one harmony lane, so they never
 * need a qualifier.
 */
export function resolveAddress(
  score: Score,
  address: Address | string,
  looking: AddressKind = 'item',
): Resolved {
  const parsed = typeof address === 'string' ? parseAddress(address) : address;
  switch (parsed.form) {
    case 'id':
      return resolveId(score, parsed.id, looking);
    case 'ordinal':
      return resolveOrdinal(score, parsed, looking);
    case 'beat':
      return resolveBeat(score, parsed, looking);
    case 'staff':
    case 'bar':
      // A bare bar names a place, not a note/rest/chord. Structure verbs use `resolveBar`;
      // anything looking for an object here has been handed a bar where it wanted a thing in one.
      throw new AddressError({ kind: 'not-an-object', text: formatAddress(parsed) });
  }
}

/**
 * The bar a `bar12` address names (V7). Structure — sections, barlines, endings — attaches to a
 * whole bar rather than to a position within one, so it resolves here rather than through
 * `resolveAddress`, which is about the notes and chords *inside* a bar. A qualified `s2.bar12` is not a whole
 * bar: it is one staff's (see `resolveStaffBar`).
 */
export function resolveBar(score: Score, address: Address | string): BarView {
  const parsed = typeof address === 'string' ? parseAddress(address) : address;
  if (parsed.form !== 'bar' || parsed.staff !== undefined || parsed.voice !== undefined) {
    throw new AddressError({ kind: 'not-a-bar', text: formatAddress(parsed) });
  }
  return barOrThrow(score, parsed.bar);
}

/** The staff a `s2`, `s2.v2` or `staff-2` reference names, with its 1-based number. */
export function resolveStaff(score: Score, reference: string): { staff: Staff; number: number; voice?: number } {
  const text = reference.trim();
  const staves = allStaves(score);
  const byId = /^staff-\d+$/.test(text) ? staves.findIndex((staff) => staff.id === text) : -1;
  if (byId >= 0) return { staff: staves[byId]!, number: byId + 1 };
  const parsed = parseAddress(text);
  if (parsed.form !== 'staff') throw new AddressError({ kind: 'not-a-position', text });
  const staff = staves[parsed.staff - 1];
  if (staff === undefined) throw new AddressError({ kind: 'no-such-staff', staff: parsed.staff, count: staves.length });
  return parsed.voice === undefined
    ? { staff, number: parsed.staff }
    : { staff, number: parsed.staff, voice: parsed.voice };
}

/** The part a `part-2` id or `p2` number names. */
export function resolvePart(score: Score, reference: string): { part: Part; number: number } {
  const text = reference.trim();
  const byNumber = /^p(\d+)$/.exec(text);
  const index = byNumber !== null ? Number(byNumber[1]) - 1 : score.parts.findIndex((part) => part.id === text);
  const part = score.parts[index];
  if (index < 0 || part === undefined) {
    throw new AddressError({
      kind: 'not-a-position',
      text: `${text}: no such part; parts are ${score.parts.map((p, at) => `p${at + 1} (${p.id})`).join(', ')}`,
    });
  }
  return { part, number: index + 1 };
}

/** One staff's bar, for `clef set s2.bar5`: the staff's number and the grid bar. */
export function resolveStaffBar(score: Score, reference: string): { staff: Staff; number: number; bar: BarView } {
  const parsed = parseAddress(reference);
  if (parsed.form !== 'bar' || parsed.staff === undefined) throw new AddressError({ kind: 'not-a-position', text: reference });
  const found = resolveStaff(score, `s${parsed.staff}`);
  return { ...found, bar: barOrThrow(score, parsed.bar) };
}

/**
 * Where an address points, whether or not anything is there. This is what an `add` needs: a
 * beat that is *not* an onset is exactly where a new note goes, so the strict rule would be
 * backwards.
 *
 * An ID resolves to the position of the object it names. A beat resolves to itself. `lane` says what the caller
 * is placing: `staff` (a note or rest, which needs a staff and voice) or `harmony` (a chord or text, which sit
 * on the one global lane and so never need a qualifier).
 */
export function resolvePosition(
  score: Score,
  address: Address | string,
  lane: 'staff' | 'harmony' = 'staff',
): Position {
  const parsed = typeof address === 'string' ? parseAddress(address) : address;
  if (parsed.form === 'beat') {
    const pick = lane === 'staff' ? selectOf(score, parsed, formatAddress(parsed), true) : null;
    const bar = barOrThrow(score, parsed.bar, pick ?? {});
    return { bar, onset: onsetOfBeat(parsed.beat, score.meta.time), select: pick ?? {} };
  }
  // An ordinal or an id names an object, and an object's position is where it sits.
  const resolved = resolveAddress(score, parsed, lane === 'harmony' ? 'chord' : 'item');
  const { bar, onset, select: where } = resolved;
  return { bar, onset, select: where };
}

function resolveId(score: Score, id: Id, looking: AddressKind): Resolved {
  const staves = allStaves(score);
  const combos: VoiceSelect[] =
    staves.length === 0
      ? [{}]
      : staves.flatMap((staff) => voiceIndexes(staff).map((voice) => ({ staff: staff.id, voice })));
  for (const pick of combos) {
    for (const gridBar of score.bars) {
      const bar = barView(score, gridBar, pick);
      for (const candidate of addressablesOf(bar)) {
        if (candidate.id === id) {
          return checkKind({ bar, target: candidate, onset: candidate.onset, select: pick }, looking, id);
        }
        // A stack member's own id names that pitch of its chord (ADR-0041 "As built: stacked chords").
        if ('kind' in candidate && candidate.kind === 'note') {
          const tone = (candidate.stack ?? []).find((member) => member.id === id);
          if (tone !== undefined) {
            return checkKind(
              { bar, target: candidate, onset: candidate.onset, select: pick, tone: { ...tone, primary: false } },
              looking,
              id,
            );
          }
        }
      }
    }
  }
  throw new AddressError({ kind: 'no-such-id', id });
}

function resolveOrdinal(
  score: Score,
  address: Address & { form: 'ordinal' },
  looking: AddressKind,
): Resolved {
  const text = formatAddress(address);
  const pick = selectOf(score, address, text, true) ?? {};
  const bar = barOrThrow(score, address.bar, pick);
  const items = orderedItems(bar);
  const target = items[address.ordinal - 1];
  if (target === undefined) {
    throw new AddressError({
      kind: 'no-such-ordinal',
      bar: address.bar,
      ordinal: address.ordinal,
      count: items.length,
    });
  }
  return withTone(
    checkKind({ bar, target, onset: target.onset, select: pick }, looking, text),
    address.tone,
    text,
    `${formatQualifier(address)}bar${address.bar}.n${address.ordinal}`,
  );
}

/** Narrow a resolved note to one pitch of its chord when the address named one (`.Eb5`); otherwise as it was. */
function withTone(resolved: Resolved, named: string | undefined, text: string, at: string): Resolved {
  if (named === undefined) return resolved;
  const target = resolved.target;
  // The chord's own pitch list is the candidate set: a rest or a lone note has one tone, so `.Eb5` names it or fails.
  if (!('kind' in target) || target.kind !== 'note') throw new AddressError({ kind: 'wrong-kind', found: 'rest', looking: 'note', at: text });
  const wanted = parsePitch(named);
  const tones = chordTones(target);
  const tone = tones.find((candidate) => samePitch(candidate.pitch, wanted));
  if (tone === undefined) {
    throw new AddressError({
      kind: 'no-such-tone',
      at,
      pitch: named,
      present: tones.map((candidate) => formatPitch(candidate.pitch)),
    });
  }
  return { ...resolved, tone };
}

function resolveBeat(
  score: Score,
  address: Address & { form: 'beat' },
  looking: AddressKind,
): Resolved {
  const text = formatAddress(address);
  // A chord sits on the harmony lane, whichever staff the address is on, so it is never ambiguous.
  const pick: VoiceSelect = looking === 'chord' ? {} : (selectOf(score, address, text, true) ?? {});
  const bar = barOrThrow(score, address.bar, pick);
  const onset = onsetOfBeat(address.beat, score.meta.time);
  const candidates = looking === 'chord' ? bar.chords : orderedItems(bar);
  const target = candidates.find((candidate) => candidate.onset === onset);

  if (target === undefined) {
    // The whole point of the strict rule: say what is there instead of guessing what was meant.
    throw new AddressError({
      kind: 'not-an-onset',
      bar: address.bar,
      beat: address.beat,
      onsets: onsetsAsBeats(score, candidates),
      looking,
    });
  }
  return withTone(
    checkKind({ bar, target, onset, select: pick }, looking, text),
    address.tone,
    text,
    `${formatQualifier(address)}bar${address.bar}.beat${formatBeat(address.beat)}`,
  );
}

function barOrThrow(score: Score, number: number, pick: VoiceSelect = {}): BarView {
  const gridBar = score.bars.find((candidate) => candidate.number === number);
  const bar = gridBar === undefined ? undefined : barView(score, gridBar, pick);
  if (bar === undefined) {
    throw new AddressError({
      kind: 'no-such-bar',
      bar: number,
      present: score.bars.map((candidate) => candidate.number),
    });
  }
  return bar;
}

/**
 * A bar's items in addressing order: **by onset, then by insertion order**.
 *
 * The second half is not decoration. A metrically invalid bar is stored as written and never
 * repaired (ADR-0013), so two items can share an onset or sit out of order, and ordinal
 * addressing still has to mean one specific thing. A stable sort over the stored array is
 * exactly "by onset, then by insertion order" (ADR-0007).
 */
export function orderedItems(bar: BarView): BarItem[] {
  return [...bar.items].sort((a, b) => a.onset - b.onset);
}

/**
 * Everything an address can name. Notes and rests share the `nK` ordinal space because a rest
 * is a first-class object (Q35) and would otherwise be unreachable by position — see the note
 * on `AddressKind` in the tests about what ADR-0007's "third note" leaves open.
 */
function addressablesOf(bar: BarView): Addressable[] {
  return [...orderedItems(bar), ...bar.chords];
}

function kindOf(target: Addressable): AddressKind {
  if (!('kind' in target)) return 'chord';
  return target.kind;
}

function checkKind(resolved: Resolved, looking: AddressKind, at: string): Resolved {
  const found = kindOf(resolved.target);
  if (looking === 'item' && found !== 'chord') return resolved;
  if (looking === found) return resolved;
  throw new AddressError({ kind: 'wrong-kind', found, looking, at });
}

/** The onsets a failure message lists, as the beats a reader would say out loud. */
function onsetsAsBeats(score: Score, candidates: readonly { onset: number }[]): number[] {
  const beats = candidates.map((candidate) => beatOfOnset(candidate.onset, score.meta.time));
  return [...new Set(beats)].sort((a, b) => a - b);
}

/** `3`, not `3.0`; `2.5`, not `2.500000001`. */
export function formatBeat(beat: number): string {
  return Number(beat.toFixed(4)).toString();
}

function formatList(numbers: readonly number[]): string {
  return numbers.join(', ');
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/** An error a human reads should read like one. `a rest`, `an item`. */
function article(kind: AddressKind): string {
  return `${'aeiou'.includes(kind[0] ?? '') ? 'an' : 'a'} ${kind}`;
}
