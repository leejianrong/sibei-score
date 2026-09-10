import type { Alter, Step } from '@sibei/model';
import type { Alteration, Chord, ChordStructure, Root, Seventh, Suspension, Triad } from './chord.js';

/**
 * Parse chord text into structure, or `null` when the text is not a chord the grammar knows
 * (ADR-0012). `null` is not an error — the caller keeps the verbatim text and flags it. The
 * grammar is deliberately *lenient on input*: it accepts the tail of real spellings a jazz
 * musician actually writes, and folds them onto one structure that `formatChord` then renders
 * one canonical way.
 *
 * Strictness lives in one place: the body scanner consumes tokens left to right, and if it
 * ever reaches a position it cannot recognise it returns `null` for the whole symbol rather
 * than keeping a half-understood chord. A chord that is 90% understood is more dangerous than
 * one flagged for a human — it would transpose wrong and print wrong with no warning.
 */
export function parseChord(text: string): Chord | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  if (isNoChord(trimmed)) return { kind: 'no-chord' };

  const rootMatch = parseRoot(trimmed, 0);
  if (rootMatch === null) return null;

  // A slash bass is a `/` whose right side is *exactly* a root. `C6/9` and `Cm7/11` are not
  // slash chords — their right side is a digit — so the check naturally leaves them in the body.
  let body = trimmed.slice(rootMatch.next);
  let bass: Root | null = null;
  const slash = body.lastIndexOf('/');
  if (slash !== -1) {
    const after = body.slice(slash + 1);
    const bassMatch = parseRoot(after, 0);
    if (bassMatch !== null && bassMatch.next === after.length) {
      bass = bassMatch.root;
      body = body.slice(0, slash);
    }
  }

  const parsed = parseBody(body);
  if (parsed === null) return null;

  return { kind: 'chord', structure: { ...parsed, root: rootMatch.root, bass } };
}

/** Whether the grammar can read this text at all. Thin sugar over `parseChord` for callers. */
export function isChord(text: string): boolean {
  return parseChord(text) !== null;
}

// ---------------------------------------------------------------------------
// N.C.
// ---------------------------------------------------------------------------

/** `N.C.`, `NC`, `N.C`, case-insensitively — the standard "no chord" marking. */
function isNoChord(text: string): boolean {
  return /^n\.?c\.?$/i.test(text);
}

// ---------------------------------------------------------------------------
// Root and slash bass
// ---------------------------------------------------------------------------

const STEPS = new Set<string>(['A', 'B', 'C', 'D', 'E', 'F', 'G']);

/**
 * A note name and its accidental, from position `i`. Used for the root and for a slash bass.
 * `##`/`bb` (and the unicode double accidentals) before the single forms, so `Bbb` reads as a
 * double flat rather than a flat with a stray `b`.
 */
function parseRoot(text: string, i: number): { root: Root; next: number } | null {
  const step = text[i];
  if (step === undefined || !STEPS.has(step)) return null;

  const rest = text.slice(i + 1);
  let alter: Alter = 0;
  let width = 0;
  if (rest.startsWith('##') || rest.startsWith('𝄪')) {
    alter = 2;
    width = rest.startsWith('##') ? 2 : 1;
  } else if (rest.startsWith('bb') || rest.startsWith('𝄫')) {
    alter = -2;
    width = rest.startsWith('bb') ? 2 : 1;
  } else if (rest.startsWith('#') || rest.startsWith('♯')) {
    alter = 1;
    width = 1;
  } else if (rest.startsWith('b') || rest.startsWith('♭')) {
    alter = -1;
    width = 1;
  }

  return { root: { step: step as Step, alter }, next: i + 1 + width };
}

// ---------------------------------------------------------------------------
// The body scanner
// ---------------------------------------------------------------------------

type BodyState = Omit<ChordStructure, 'root' | 'bass'>;

function blank(): BodyState {
  return {
    triad: 'major',
    seventh: null,
    extension: null,
    sixth: false,
    power: false,
    suspension: null,
    additions: [],
    alterations: [],
    alt: false,
  };
}

/**
 * Consume the chord body — everything after the root and before a slash bass — token by token.
 *
 * Two things drive the disambiguation the jazz vocabulary needs:
 * - **Position.** A leading `-`/`+` is a quality (minor / augmented); the same character after a
 *   number is an alteration sign (`C-7` is minor, `C7-5` is a flat five). `sawTop` tracks which
 *   side of the first number we are on.
 * - **A `maj` flag.** `maj`/`Δ`/`^` do not themselves add a seventh — `Cmaj` is a plain triad —
 *   but they colour the *next* number: `maj9` is a major seventh with a ninth, `9` alone is a
 *   dominant.
 */
function parseBody(body: string): BodyState | null {
  const st = blank();
  let majorSeventh = false;
  let sawTop = false;
  let i = 0;

  while (i < body.length) {
    const rest = body.slice(i);
    let m: RegExpExecArray | null;

    // Half-diminished: a self-contained token, so it is tried before `m` could eat the start.
    if ((m = /^(ø7?|%)/.exec(rest))) {
      st.triad = 'minor';
      st.seventh = 'minor';
      addAlteration(st, 5, -1);
      sawTop = true;
      i += m[0].length;
      continue;
    }

    // The maj7 symbols `Δ` and `^` imply the seventh on their own: `CΔ` is `Cmaj7`. (The word
    // `maj` does not — `Cmaj` is a plain triad — so it only colours a following number.)
    if ((m = /^(Δ|\^)/.exec(rest))) {
      majorSeventh = true;
      st.seventh = 'major';
      sawTop = true;
      i += m[0].length;
      continue;
    }

    // Major-seventh quality flag. `major`/`maj` before `ma` so a longer word wins its own length.
    if ((m = /^(major|maj|Maj|MAJ|Ma|ma)/.exec(rest))) {
      majorSeventh = true;
      i += m[0].length;
      continue;
    }
    if ((m = /^M(?=\d)/.exec(rest))) {
      majorSeventh = true;
      i += 1;
      continue;
    }

    // Minor. `-` only counts as minor before the first number (`C-7`); after one it is a flat sign.
    if ((m = /^(minor|min|mi|m)/.exec(rest))) {
      st.triad = 'minor';
      i += m[0].length;
      continue;
    }
    if (rest.startsWith('-') && !sawTop) {
      st.triad = 'minor';
      i += 1;
      continue;
    }

    // Diminished, then augmented. `o`/`°` dim, `+` aug (aug only in quality position).
    if ((m = /^(dim|°|o)/.exec(rest))) {
      st.triad = 'diminished';
      i += m[0].length;
      continue;
    }
    if ((m = /^aug/.exec(rest))) {
      st.triad = 'augmented';
      i += 3;
      continue;
    }
    if (rest.startsWith('+') && !sawTop) {
      st.triad = 'augmented';
      i += 1;
      continue;
    }

    // Suspensions, additions, and the `alt` shorthand.
    if ((m = /^sus(2|4)?/.exec(rest))) {
      st.suspension = m[1] === '2' ? 'sus2' : 'sus4';
      i += m[0].length;
      continue;
    }
    if ((m = /^add(\d+)/.exec(rest))) {
      st.additions.push(Number(m[1]));
      i += m[0].length;
      continue;
    }
    if ((m = /^alt/.exec(rest))) {
      st.alt = true;
      if (st.seventh === null) st.seventh = 'minor';
      sawTop = true;
      i += 3;
      continue;
    }

    // A sixth-nine, in either of its two written forms, before the bare-6 rule below.
    if ((m = /^(6\/9|69)/.exec(rest))) {
      st.sixth = true;
      st.additions.push(9);
      sawTop = true;
      i += m[0].length;
      continue;
    }

    // An alteration: a sign then a degree. Tried before the bare number so `b5` is not read as `b`
    // (nothing) then `5`.
    if ((m = /^(b|♭|#|♯|\+|-)(13|11|9|5)/.exec(rest))) {
      const dir = m[1] === 'b' || m[1] === '♭' || m[1] === '-' ? -1 : 1;
      addAlteration(st, Number(m[2]) as Alteration['degree'], dir);
      sawTop = true;
      i += m[0].length;
      continue;
    }

    // A bare number: the seventh/extension, a sixth, or a power fifth.
    if ((m = /^(13|11|9|7|6|5)/.exec(rest))) {
      applyNumber(st, Number(m[1]), majorSeventh);
      sawTop = true;
      i += m[0].length;
      continue;
    }

    // Anything else means this is not a chord the grammar knows.
    return null;
  }

  return st;
}

function applyNumber(st: BodyState, n: number, majorSeventh: boolean): void {
  if (n === 6) {
    st.sixth = true;
    return;
  }
  if (n === 5) {
    st.power = true;
    return;
  }
  // 7, 9, 11, 13: a seventh, and for 9/11/13 the extension stack up to it.
  st.seventh = majorSeventh ? 'major' : st.triad === 'diminished' ? 'diminished' : 'minor';
  if (n > 7) st.extension = n as 9 | 11 | 13;
}

/** Record an altered degree, replacing any earlier alteration of the same degree. */
function addAlteration(st: BodyState, degree: Alteration['degree'], alter: Alteration['alter']): void {
  const others = st.alterations.filter((a) => a.degree !== degree);
  st.alterations = [...others, { degree, alter }];
}
