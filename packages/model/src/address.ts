import { beatOfOnset, onsetOfBeat } from './duration.js';
import type { Bar, BarItem, Chord, Id, Note, Rest, Score } from './score.js';

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

/** The three forms, parsed. */
export type Address =
  /** `bar12.beat3` — a beat within a bar. 1-based, fractional between beats. */
  | { form: 'beat'; bar: number; beat: number }
  /** `bar12.n3` — the third item in bar 12, ordered by onset then by insertion order. */
  | { form: 'ordinal'; bar: number; ordinal: number }
  /** `note-17` — a stable ID. */
  | { form: 'id'; id: Id };

/**
 * What the caller is looking for. The CLI verb knows: `note set` wants a note, `chord set`
 * wants a chord. Passing it in is what turns "there is something there but not what you meant"
 * into a precise error instead of a silent mismatch.
 */
export type AddressKind = 'item' | 'note' | 'rest' | 'chord';

export type Addressable = Note | Rest | Chord;

export interface Resolved<T extends Addressable = Addressable> {
  bar: Bar;
  target: T;
  /** Ticks from the start of the bar. */
  onset: number;
}

/** Where an address points, whether or not anything is there yet. */
export interface Position {
  bar: Bar;
  onset: number;
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
  | { kind: 'wrong-kind'; found: AddressKind; looking: AddressKind; at: string }
  | { kind: 'not-a-position'; text: string };

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
        `Expected bar12.beat3, bar12.n3, or an id like note-17.`
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
    case 'wrong-kind':
      return `${failure.at} is ${article(failure.found)}, not ${article(failure.looking)}`;
    case 'not-a-position':
      return (
        `${JSON.stringify(failure.text)} names an object rather than a place. ` +
        `Use a beat address like bar12.beat3 to say where.`
      );
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** `bar0` is the pickup, so bar 1 is the first full bar, matching how musicians count. */
const BEAT_FORM = /^bar(\d+)\.beat(\d+(?:\.\d+)?)$/;
const ORDINAL_FORM = /^bar(\d+)\.n(\d+)$/;
const ID_FORM = /^[a-z]+-\d+$/;

/** Syntax only — no score consulted, so this cannot tell you whether the thing exists. */
export function parseAddress(text: string): Address {
  const trimmed = text.trim();

  const ordinal = ORDINAL_FORM.exec(trimmed);
  if (ordinal !== null) {
    const [, bar, n] = ordinal;
    // n0 is not the zeroth item; ordinals are 1-based like everything a musician counts.
    if (Number(n) < 1) throw new AddressError({ kind: 'syntax', text });
    return { form: 'ordinal', bar: Number(bar), ordinal: Number(n) };
  }

  const beat = BEAT_FORM.exec(trimmed);
  if (beat !== null) {
    const [, bar, b] = beat;
    if (Number(b) < 1) throw new AddressError({ kind: 'syntax', text });
    return { form: 'beat', bar: Number(bar), beat: Number(b) };
  }

  if (ID_FORM.test(trimmed)) return { form: 'id', id: trimmed };

  throw new AddressError({ kind: 'syntax', text });
}

/** The address, printed. The text projection prints these, so an agent never constructs one. */
export function formatAddress(address: Address): string {
  switch (address.form) {
    case 'beat':
      return `bar${address.bar}.beat${formatBeat(address.beat)}`;
    case 'ordinal':
      return `bar${address.bar}.n${address.ordinal}`;
    case 'id':
      return address.id;
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * The object an address names. Strict: if there is nothing at that position, the error lists
 * the onsets that do exist.
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
  }
}

/**
 * Where an address points, whether or not anything is there. This is what an `add` needs: a
 * beat that is *not* an onset is exactly where a new note goes, so the strict rule would be
 * backwards.
 *
 * An ID resolves to the position of the object it names. A beat resolves to itself.
 */
export function resolvePosition(score: Score, address: Address | string): Position {
  const parsed = typeof address === 'string' ? parseAddress(address) : address;
  if (parsed.form === 'beat') {
    const bar = barOrThrow(score, parsed.bar);
    return { bar, onset: onsetOfBeat(parsed.beat, score.meta.time) };
  }
  // An ordinal or an id names an object, and an object's position is where it sits.
  const resolved = resolveAddress(score, parsed, 'item');
  return { bar: resolved.bar, onset: resolved.onset };
}

function resolveId(score: Score, id: Id, looking: AddressKind): Resolved {
  for (const bar of score.bars) {
    for (const candidate of addressablesOf(bar)) {
      if (candidate.id === id) return checkKind({ bar, target: candidate, onset: candidate.onset }, looking, id);
    }
  }
  throw new AddressError({ kind: 'no-such-id', id });
}

function resolveOrdinal(
  score: Score,
  address: { bar: number; ordinal: number },
  looking: AddressKind,
): Resolved {
  const bar = barOrThrow(score, address.bar);
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
  return checkKind(
    { bar, target, onset: target.onset },
    looking,
    `bar${address.bar}.n${address.ordinal}`,
  );
}

function resolveBeat(
  score: Score,
  address: { bar: number; beat: number },
  looking: AddressKind,
): Resolved {
  const bar = barOrThrow(score, address.bar);
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
  return checkKind(
    { bar, target, onset },
    looking,
    `bar${address.bar}.beat${formatBeat(address.beat)}`,
  );
}

function barOrThrow(score: Score, number: number): Bar {
  const bar = score.bars.find((candidate) => candidate.number === number);
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
export function orderedItems(bar: Bar): BarItem[] {
  return [...bar.items].sort((a, b) => a.onset - b.onset);
}

/**
 * Everything an address can name. Notes and rests share the `nK` ordinal space because a rest
 * is a first-class object (Q35) and would otherwise be unreachable by position — see the note
 * on `AddressKind` in the tests about what ADR-0007's "third note" leaves open.
 */
function addressablesOf(bar: Bar): Addressable[] {
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
