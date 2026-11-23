import { INSTRUMENT_PRESETS, MAX_SETUP_INSTRUMENTS } from '@sibei/model';
import type { KeySignature, NoteValue, TimeSignature } from '@sibei/model';
import type { Operation } from './api.js';

/**
 * Starting a chart from the browser (SIB2-270): the form behind the library's New chart control, and
 * the sample chart. Both are plain `score.create` batches, the same operation `sbscore new` sends,
 * built here as data so a test can pin them without a DOM. This closes the last Q79 exception.
 */

export interface NewChartForm {
  title: string;
  /** `C`, `Db`, `F#m`: the CLI's own spelling (`sbscore new --key`). */
  key: string;
  /** `4/4`, `6/8`. */
  time: string;
  bars: number;
  pickup: boolean;
  /** Instrument presets, top to bottom (SIB2-288); empty is the plain lead sheet (`sbscore new --instrument`, repeated). */
  instruments?: readonly string[];
}

/** What the picker offers: the model's catalogue, the one `sbscore new --instrument` resolves against. */
export const INSTRUMENT_CHOICES: readonly { id: string; label: string }[] = INSTRUMENT_PRESETS.map((preset) => ({
  id: preset.id,
  label: preset.name === '' ? 'Lead sheet' : preset.name,
}));

/** The picker's operations on its list, as pure functions so a test can pin them without a DOM. */
export const instrumentList = {
  add: (list: readonly string[]): string[] => (list.length >= MAX_SETUP_INSTRUMENTS ? [...list] : [...list, list.length === 0 ? 'piano' : 'bass']),
  remove: (list: readonly string[], at: number): string[] => list.filter((_, index) => index !== at),
  change: (list: readonly string[], at: number, id: string): string[] => list.map((entry, index) => (index === at ? id : entry)),
  /** One row earlier (`-1`) or later (`1`); a move off either end is no move. */
  move: (list: readonly string[], at: number, by: -1 | 1): string[] => {
    const to = at + by;
    if (to < 0 || to >= list.length) return [...list];
    const next = [...list];
    [next[at], next[to]] = [next[to]!, next[at]!];
    return next;
  },
};

export const KEY_CHOICES: readonly string[] = [
  'C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'G', 'D', 'A', 'E', 'B', 'F#',
  'Am', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Em', 'Bm', 'F#m', 'C#m', 'G#m',
];

export const TIME_CHOICES: readonly string[] = ['4/4', '3/4', '2/4', '6/8', '12/8', '5/4', '7/4', '2/2'];

export const MIN_BARS = 1;
export const MAX_BARS = 200;

const ALTERS: Record<string, number> = { bb: -2, b: -1, '': 0, '#': 1, '##': 2 };

/** The CLI's `parseKey`, restated: the browser may not import the CLI. */
export function keyFrom(spec: string): KeySignature | null {
  const match = /^([A-G])(bb|b|#|##)?(m)?$/.exec(spec.trim());
  if (match === null) return null;
  return {
    tonic: (match[1] ?? 'C') as KeySignature['tonic'],
    alter: (ALTERS[match[2] ?? ''] ?? 0) as KeySignature['alter'],
    mode: match[3] === undefined ? 'major' : 'minor',
  };
}

export function timeFrom(spec: string): TimeSignature | null {
  const match = /^(\d+)\/(\d+)$/.exec(spec.trim());
  if (match === null) return null;
  return { beats: Number(match[1]), beatValue: Number(match[2]) as NoteValue };
}

/** A readable, URL-safe id: the title's words, then a short time-based suffix so two charts never collide. */
export function chartId(title: string, now: number = Date.now()): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return `${slug === '' ? 'chart' : slug}-${now.toString(36).slice(-5)}`;
}

/** Why the form cannot be submitted, or null. */
export function problemWith(form: NewChartForm): string | null {
  if (!Number.isInteger(form.bars) || form.bars < MIN_BARS || form.bars > MAX_BARS) {
    return `Bars must be a whole number from ${MIN_BARS} to ${MAX_BARS}.`;
  }
  if (keyFrom(form.key) === null) return 'Pick a key.';
  if (timeFrom(form.time) === null) return 'Pick a time signature.';
  if ((form.instruments?.length ?? 0) > MAX_SETUP_INSTRUMENTS) return `Start with at most ${MAX_SETUP_INSTRUMENTS} instruments.`;
  return null;
}

export function newChartOps(form: NewChartForm, id: string): Operation[] {
  const payload: Extract<Operation, { type: 'score.create' }>['payload'] = { id, barCount: form.bars };
  const title = form.title.trim();
  if (title !== '') payload.title = title;
  const key = keyFrom(form.key);
  if (key !== null) payload.key = key;
  const time = timeFrom(form.time);
  if (time !== null) payload.time = time;
  if (form.pickup) payload.pickup = true;
  if (form.instruments !== undefined && form.instruments.length > 0) payload.instruments = [...form.instruments];
  return [{ type: 'score.create', payload }];
}

/** A twelve-bar blues in F, chords only: enough to show a chart, to play from and to edit. */
const SAMPLE_CHORDS: readonly [number, string][] = [
  [1, 'F7'], [2, 'Bb7'], [3, 'F7'], [4, 'Cm7'], [5, 'Bb7'], [6, 'Bb7'],
  [7, 'F7'], [8, 'D7'], [9, 'Gm7'], [10, 'C7'], [11, 'F7'], [12, 'C7'],
];

export function sampleChartOps(id: string): Operation[] {
  return [
    {
      type: 'score.create',
      payload: {
        id,
        title: 'Sample blues in F',
        composer: 'Sibei',
        key: { tonic: 'F', alter: 0, mode: 'major' },
        time: { beats: 4, beatValue: 4 },
        barCount: 12,
      },
    },
    ...SAMPLE_CHORDS.map(([bar, text]): Operation => ({ type: 'chord.set', target: `bar${bar}.beat1`, payload: { text } })),
  ];
}
