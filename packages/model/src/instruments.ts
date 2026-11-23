import type { Clef, StaffType } from './score.js';

/**
 * The instrument presets a new chart can start from (SIB2-272, SIB2-288): a short list of the instruments a jazz
 * lead sheet or a small band chart wants, each with what `part.add` and `staff.add` would otherwise be told one field
 * at a time. Plain data, shared by the applier (which resolves a preset id), the CLI (`new --instrument piano`) and the
 * browser's picker, so the three can never disagree about what "Trumpet in Bb" means.
 *
 * `transposition` is semitones from sounding up to written (ADR-0041), the same intervals `export --for` uses
 * (`music/part.ts`): a Bb trumpet is written a major second above concert, so +2; an Eb alto a major sixth, +9; a Bb
 * tenor a major ninth, +14. A preset is a starting point, not a catalogue: every field stays editable afterwards.
 */
export interface InstrumentPreset {
  /** What `--instrument` and the picker send. */
  id: string;
  /** The name printed at the head of the first system. */
  name: string;
  /** The abbreviation printed on later systems. Empty for the lead sheet, which prints no name. */
  shortName: string;
  /** A General MIDI program (0-based), or null. */
  program: number | null;
  transposition: number;
  /** Top to bottom: a piano is a treble and a bass staff, which draw under a brace. */
  staves: { type: StaffType; clef: Clef }[];
}

export const INSTRUMENT_PRESETS: readonly InstrumentPreset[] = [
  { id: 'lead-sheet', name: '', shortName: '', program: null, transposition: 0, staves: [{ type: 'standard', clef: 'treble' }] },
  {
    id: 'piano',
    name: 'Piano',
    shortName: 'Pno.',
    program: 0,
    transposition: 0,
    staves: [
      { type: 'standard', clef: 'treble' },
      { type: 'standard', clef: 'bass' },
    ],
  },
  { id: 'voice', name: 'Voice', shortName: 'Vo.', program: 52, transposition: 0, staves: [{ type: 'standard', clef: 'treble' }] },
  { id: 'guitar', name: 'Guitar', shortName: 'Gtr.', program: 26, transposition: 0, staves: [{ type: 'standard', clef: 'treble' }] },
  { id: 'bass', name: 'Bass', shortName: 'Bass', program: 32, transposition: 0, staves: [{ type: 'standard', clef: 'bass' }] },
  { id: 'drums', name: 'Drum Kit', shortName: 'Dr.', program: null, transposition: 0, staves: [{ type: 'percussion', clef: 'percussion' }] },
  { id: 'trumpet-bb', name: 'Trumpet in Bb', shortName: 'Tpt.', program: 56, transposition: 2, staves: [{ type: 'standard', clef: 'treble' }] },
  { id: 'alto-sax-eb', name: 'Alto Sax in Eb', shortName: 'A. Sax', program: 65, transposition: 9, staves: [{ type: 'standard', clef: 'treble' }] },
  { id: 'tenor-sax-bb', name: 'Tenor Sax in Bb', shortName: 'T. Sax', program: 66, transposition: 14, staves: [{ type: 'standard', clef: 'treble' }] },
  { id: 'flute', name: 'Flute', shortName: 'Fl.', program: 73, transposition: 0, staves: [{ type: 'standard', clef: 'treble' }] },
  { id: 'violin', name: 'Violin', shortName: 'Vln.', program: 40, transposition: 0, staves: [{ type: 'standard', clef: 'treble' }] },
  { id: 'cello', name: 'Cello', shortName: 'Vc.', program: 42, transposition: 0, staves: [{ type: 'standard', clef: 'bass' }] },
];

/** The most instruments one new chart starts with. */
export const MAX_SETUP_INSTRUMENTS = 16;

export function instrumentPreset(id: string): InstrumentPreset | undefined {
  return INSTRUMENT_PRESETS.find((preset) => preset.id === id);
}

/**
 * One part of a new chart, as `score.create` records it (authoritative on replay, so a later change to the catalogue
 * can never alter what an old log builds). Ids are the ones the applier chose.
 */
export interface PartSetup {
  id: string;
  name: string;
  shortName?: string;
  instrument: number | null;
  transposition: number;
  staves: { id: string; type: StaffType; clef: Clef }[];
}

/** The parts a list of preset ids stands for, with fresh `part-N` and `staff-N` ids, or the first unknown id. */
export function planSetup(ids: readonly string[]): { ok: true; parts: PartSetup[] } | { ok: false; unknown: string } {
  const parts: PartSetup[] = [];
  let staffCount = 0;
  for (const [index, id] of ids.entries()) {
    const preset = instrumentPreset(id);
    if (preset === undefined) return { ok: false, unknown: id };
    parts.push({
      id: `part-${index + 1}`,
      name: preset.name,
      ...(preset.shortName === '' ? {} : { shortName: preset.shortName }),
      instrument: preset.program,
      transposition: preset.transposition,
      staves: preset.staves.map((staff) => ({ id: `staff-${++staffCount}`, type: staff.type, clef: staff.clef })),
    });
  }
  return { ok: true, parts };
}
