/**
 * Rich chord generation for the training corpus (V17b, ADR-0031).
 *
 * The eval/generator's original chords were the seven diatonic sevenths of one key — enough to
 * measure a recogniser, far too narrow to *train* one: a model that only ever saw `maj7/m7/7/m7b5`
 * in C would never learn the altered dominants, extensions, sus and slash chords that fill a real
 * lead sheet. This module draws chords across the whole grammar (`@sibei/music`) so the corpus, and
 * the chord-band recogniser trained on it, meet the variety a real chart has.
 *
 * The chords **roam chromatically and harmonically** while the melody stays in the chart's key: on a
 * real lead sheet the written key is fixed but the chords wander (secondary dominants, tritone subs,
 * modal interchange), and — decisively for us — keeping the *melody* in key means the Stage-2a note
 * model and its vocabulary (trained on C major, retrain deferred to KAN-1487) are untouched, so only
 * the chord axis widens here (`generate.ts` sources chord content from a separate `Rng`, leaving the
 * note stream byte-identical).
 *
 * Every structure this emits round-trips through `formatChord`/`parseChord` (asserted in the tests),
 * and `enumerateChordSpace()` exposes the closed space it draws from so the CTC vocabulary can be
 * built complete-by-construction (V17b-ii), the same discipline `vocab.ts` uses for notes.
 *
 * Framework-free, Node-free plain TypeScript, deterministic in the `Rng` handed in.
 */

import type { Alter, Step } from '@sibei/model';
import type { Alteration, ChordStructure, Root } from '@sibei/music';
import type { Rng } from './rng.js';

const STEPS: readonly Step[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
/** Root spellings: naturals, then a sharp or a flat. No double accidentals on a root — vanishingly rare. */
const ROOT_ALTERS: readonly Alter[] = [0, 1, -1];

/**
 * A chord-quality template: the body fields that make a `maj7` a `maj7`, minus the root, the slash
 * bass and any extra random tensions. `allowTensions` marks the qualities a jazz reader decorates
 * (the dominants and their extensions); the rest stay clean.
 */
export interface ChordQuality {
  name: string;
  triad: ChordStructure['triad'];
  seventh: ChordStructure['seventh'];
  extension: ChordStructure['extension'];
  sixth: boolean;
  power: boolean;
  suspension: ChordStructure['suspension'];
  alt: boolean;
  /** Alterations intrinsic to the quality, e.g. the `♭5` of a half-diminished chord. */
  baseAlterations: readonly Alteration[];
  /** Whether extra random tensions (♭9/♯9/♯11/♭13/♯5) may decorate it — dominants only. */
  allowTensions: boolean;
  weight: number;
}

function q(name: string, fields: Partial<ChordQuality>): ChordQuality {
  return {
    name,
    triad: 'major',
    seventh: null,
    extension: null,
    sixth: false,
    power: false,
    suspension: null,
    alt: false,
    baseAlterations: [],
    allowTensions: false,
    weight: 1,
    ...fields,
  };
}

/** The qualities the corpus draws from — the common jazz vocabulary, weighted toward the frequent ones. */
export const CHORD_QUALITIES: readonly ChordQuality[] = [
  q('maj', { triad: 'major', weight: 2 }),
  q('min', { triad: 'minor', weight: 2 }),
  q('maj7', { triad: 'major', seventh: 'major', weight: 4 }),
  q('maj9', { triad: 'major', seventh: 'major', extension: 9, weight: 1 }),
  q('m7', { triad: 'minor', seventh: 'minor', weight: 4 }),
  q('m9', { triad: 'minor', seventh: 'minor', extension: 9, weight: 1 }),
  q('7', { triad: 'major', seventh: 'minor', allowTensions: true, weight: 4 }),
  q('9', { triad: 'major', seventh: 'minor', extension: 9, allowTensions: true, weight: 2 }),
  q('11', { triad: 'major', seventh: 'minor', extension: 11, allowTensions: true, weight: 1 }),
  q('13', { triad: 'major', seventh: 'minor', extension: 13, allowTensions: true, weight: 2 }),
  q('m7b5', {
    triad: 'minor',
    seventh: 'minor',
    baseAlterations: [{ degree: 5, alter: -1 }],
    weight: 2,
  }),
  q('dim7', { triad: 'diminished', seventh: 'diminished', weight: 1 }),
  q('aug', { triad: 'augmented', weight: 1 }),
  q('6', { triad: 'major', sixth: true, weight: 1 }),
  q('m6', { triad: 'minor', sixth: true, weight: 1 }),
  q('sus4', { suspension: 'sus4', seventh: 'minor', allowTensions: true, weight: 1 }),
  q('7alt', { triad: 'major', seventh: 'minor', alt: true, weight: 1 }),
];

/** The tensions a dominant may pick up. A degree appears at most once (dedup keeps the grammar happy). */
const TENSIONS: readonly Alteration[] = [
  { degree: 5, alter: 1 },
  { degree: 5, alter: -1 },
  { degree: 9, alter: -1 },
  { degree: 9, alter: 1 },
  { degree: 11, alter: 1 },
  { degree: 13, alter: -1 },
];

function makeStructure(
  root: Root,
  quality: ChordQuality,
  alterations: readonly Alteration[],
  bass: Root | null,
): ChordStructure {
  return {
    root,
    triad: quality.triad,
    seventh: quality.seventh,
    extension: quality.extension,
    sixth: quality.sixth,
    power: quality.power,
    suspension: quality.suspension,
    additions: [],
    alterations: [...alterations],
    alt: quality.alt,
    bass,
  };
}

/** A random, grammar-valid chord across the corpus's whole harmonic space. */
export function randomChordStructure(rng: Rng): ChordStructure {
  const root: Root = { step: rng.pick(STEPS), alter: rng.weighted(ROOT_ALTERS, [6, 2, 2]) };
  const quality = rng.weighted(
    CHORD_QUALITIES,
    CHORD_QUALITIES.map((entry) => entry.weight),
  );

  const alterations: Alteration[] = [...quality.baseAlterations];
  // `alt` already says "altered dominant" — do not also spell tensions, `7alt` is the whole symbol.
  if (quality.allowTensions && !quality.alt && rng.bool(0.35)) {
    const seen = new Set(alterations.map((a) => a.degree));
    const count = rng.int(1, 2);
    for (let i = 0; i < count; i += 1) {
      const tension = rng.pick(TENSIONS);
      if (!seen.has(tension.degree)) {
        alterations.push(tension);
        seen.add(tension.degree);
      }
    }
  }

  const bass = rng.bool(0.12)
    ? { step: rng.pick(STEPS), alter: rng.weighted(ROOT_ALTERS, [6, 2, 2]) }
    : null;

  return makeStructure(root, quality, alterations, bass);
}

/**
 * The closed set of structures the generator can emit, for building the CTC vocabulary
 * complete-by-construction (V17b-ii). Every root × quality, each quality's base alterations plus one
 * example of each single tension it allows, with and without a slash bass — enough that every glyph a
 * random chord can carry appears at least once. Not the random distribution; the coverage.
 */
export function enumerateChordSpace(): ChordStructure[] {
  const out: ChordStructure[] = [];
  const roots: Root[] = STEPS.flatMap((step) => ROOT_ALTERS.map((alter) => ({ step, alter })));
  const exampleBass: Root = { step: 'E', alter: 0 };

  for (const root of roots) {
    for (const quality of CHORD_QUALITIES) {
      const base = [...quality.baseAlterations];
      const variants: Alteration[][] = [base];
      if (quality.allowTensions && !quality.alt) {
        for (const tension of TENSIONS) {
          if (!base.some((a) => a.degree === tension.degree)) variants.push([...base, tension]);
        }
      }
      for (const alterations of variants) {
        out.push(makeStructure(root, quality, alterations, null));
        out.push(makeStructure(root, quality, alterations, exampleBass));
      }
    }
  }
  return out;
}
