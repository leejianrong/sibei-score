import type { Alter, Step } from '@sibei/model';

/**
 * The chord grammar's data model (ADR-0012). A chord *symbol* is text a user or an agent
 * typed, or that OCR produced; this is the **structure** it parses to — root, quality,
 * seventh, extensions, alterations, suspensions, a slash bass. Parsed structure is what
 * makes transposition (ADR-0016) and enharmonic respelling (ADR-0017) possible at all, and
 * what the jazz typography in the engraver reads to know a `maj7` from a `m7b5` (V5d).
 *
 * Framework-free, Node-free plain TypeScript, for the same reason `model` is: this runs in
 * the browser and on the server (ADR-0005), and it is the OCR corrector too (ADR-0011), so
 * it may not depend on anything a phone-photo import pipeline cannot also load.
 *
 * **Read leniently, write strictly.** `parseChord` accepts the long tail of real jazz
 * spellings — `CM7`, `C-7`, `Cma7`, `Cø`, `C°7` — and maps them all onto one structure;
 * `formatChord` emits exactly one canonical spelling of that structure. Text the grammar
 * cannot parse is not represented here at all: `parseChord` returns `null`, and the caller
 * keeps the verbatim text and flags it (ADR-0012), never rejecting it.
 */

/** A chord's root, or a slash bass. A pitch class with a spelling, and no octave. */
export interface Root {
  step: Step;
  alter: Alter;
}

/** The triad under everything else. `b5`/`#5` on a dominant live in `alterations`, not here. */
export type Triad = 'major' | 'minor' | 'diminished' | 'augmented';

/**
 * The seventh, when there is one.
 * - `minor` — a flat seventh: the dominant `C7`, and the seventh of `Cm7`.
 * - `major` — `Cmaj7` / `CΔ`.
 * - `diminished` — the double-flat seventh of a fully diminished `Cdim7`.
 */
export type Seventh = 'minor' | 'major' | 'diminished';

/** Which way an altered degree bends. */
export type AlterDirection = -1 | 1;

/** An explicitly altered chord degree: `b5`, `#5`, `b9`, `#9`, `#11`, `b13`. */
export interface Alteration {
  degree: 5 | 9 | 11 | 13;
  alter: AlterDirection;
}

export type Suspension = 'sus2' | 'sus4';

/**
 * The parsed body of a chord that is not `N.C.`.
 *
 * `extension` is the *highest* stacked tension — a `13` chord implies the 9 and 11 beneath
 * it, the way a jazz reader reads it, so only the top is stored. Alterations to a degree
 * (`#11`, `b9`) are separate from the natural stack and always listed explicitly.
 */
export interface ChordStructure {
  root: Root;
  triad: Triad;
  seventh: Seventh | null;
  /** The top of the natural extension stack, `null` when the chord is a plain triad/seventh. */
  extension: 9 | 11 | 13 | null;
  /** A sixth chord (`C6`, `Cm6`). A `6/9` is a sixth with `9` in `additions`. */
  sixth: boolean;
  /** A bare fifth, `C5` — no third at all. */
  power: boolean;
  /** `sus2` / `sus4`: the third is replaced, not added. */
  suspension: Suspension | null;
  /** Added tones that do not imply the stack beneath them, e.g. the `9` of `add9`. */
  additions: number[];
  alterations: Alteration[];
  /** The `alt` shorthand: a dominant seventh with the alterations left to the player (`C7alt`). */
  alt: boolean;
  /** A slash bass, `Ab/Eb`. */
  bass: Root | null;
}

/**
 * A parsed chord. `no-chord` is `N.C.` — a real, parseable marking that a bar is unharmonised,
 * distinct from text the grammar could not read (which is not a `Chord` at all — see the module
 * doc).
 */
export type Chord =
  | { kind: 'chord'; structure: ChordStructure }
  | { kind: 'no-chord' };
