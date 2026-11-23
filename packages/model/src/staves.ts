import type {
  Bar,
  BarView,
  Clef,
  Chord,
  Annotation,
  BarItem,
  HarmonyBar,
  Id,
  Part,
  Score,
  Staff,
  StaffBar,
  Tuplet,
  Voice,
} from './score.js';

/**
 * Accessors over the ADR-0041 document shape. Nothing outside this file (and the migration that builds it) should
 * walk `Score.parts` or `Score.harmony` by hand: a lead-sheet consumer asks for a `BarView`, which is the
 * pre-ADR-0041 `Bar` — grid entry plus the first staff's first voice and the harmony lane — and writes it back with
 * `withBarView`. Later slices add multi-staff and multi-voice by passing a `VoiceSelect`; every existing caller
 * keeps meaning the first staff, first voice (ADR-0041 section 2).
 */

/** Which staff and voice a view reads and writes. Absent means the first staff, voice 1. */
export interface VoiceSelect {
  staff?: Id;
  voice?: number;
}

export const DEFAULT_PART_ID = 'part-1';
export const DEFAULT_STAFF_ID = 'staff-1';
export const FIRST_VOICE = 1;

/** A fresh, empty voice. */
export function emptyVoice(index: number = FIRST_VOICE): Voice {
  return { index, items: [], tuplets: [] };
}

/** The one-part, one-staff, one-voice structure every lead sheet has, with an empty entry per bar. */
export function defaultParts(barIds: readonly Id[]): Part[] {
  return [
    {
      id: DEFAULT_PART_ID,
      name: '',
      instrument: null,
      transposition: 0,
      staves: [
        {
          id: DEFAULT_STAFF_ID,
          type: 'standard',
          clef: 'treble',
          bars: barIds.map((barId): StaffBar => ({ barId, voices: [emptyVoice()] })),
        },
      ],
    },
  ];
}

/** The staff a selection names: the first staff of the first part by default; undefined when there is none. */
export function staffOf(score: Score, select: VoiceSelect = {}): Staff | undefined {
  for (const part of score.parts) {
    for (const staff of part.staves) {
      if (select.staff === undefined || staff.id === select.staff) return staff;
    }
  }
  return undefined;
}

/** Every staff, in part order. */
export function allStaves(score: Score): Staff[] {
  return score.parts.flatMap((part) => part.staves);
}

function voiceOf(staffBar: StaffBar | undefined, index: number): Voice | undefined {
  return staffBar?.voices.find((voice) => voice.index === index);
}

const NO_ITEMS: BarItem[] = [];
const NO_TUPLETS: Tuplet[] = [];
const NO_CHORDS: Chord[] = [];
const NO_TEXT: Annotation[] = [];

/** The old-shape bar for one grid entry: the first staff's first voice and the harmony lane. */
export function barView(score: Score, bar: Bar, select: VoiceSelect = {}): BarView {
  const staff = staffOf(score, select);
  const staffBar = staff?.bars.find((candidate) => candidate.barId === bar.id);
  const voice = voiceOf(staffBar, select.voice ?? FIRST_VOICE);
  const harmony = score.harmony.find((entry) => entry.barId === bar.id);
  return {
    ...bar,
    items: voice?.items ?? NO_ITEMS,
    tuplets: voice?.tuplets ?? NO_TUPLETS,
    chords: harmony?.chords ?? NO_CHORDS,
    annotations: harmony?.annotations ?? NO_TEXT,
  };
}

/** A view of every bar, in grid order. */
export function barViews(score: Score, select: VoiceSelect = {}): BarView[] {
  const staff = staffOf(score, select);
  const byBar = new Map(staff?.bars.map((staffBar) => [staffBar.barId, staffBar]));
  const harmonyByBar = new Map(score.harmony.map((entry) => [entry.barId, entry]));
  const index = select.voice ?? FIRST_VOICE;
  return score.bars.map((bar) => {
    const voice = voiceOf(byBar.get(bar.id), index);
    const harmony = harmonyByBar.get(bar.id);
    return {
      ...bar,
      items: voice?.items ?? NO_ITEMS,
      tuplets: voice?.tuplets ?? NO_TUPLETS,
      chords: harmony?.chords ?? NO_CHORDS,
      annotations: harmony?.annotations ?? NO_TEXT,
    };
  });
}

/** The view of the bar with this id, or undefined. */
export function findBarView(score: Score, barId: Id, select: VoiceSelect = {}): BarView | undefined {
  const bar = score.bars.find((candidate) => candidate.id === barId);
  return bar === undefined ? undefined : barView(score, bar, select);
}

/** The grid entry of a view: the view without its lifted content. */
export function gridBar(view: Bar): Bar {
  const { id, number, startBarline, endBarline, ending, review, lineBreak } = view as BarView;
  const bar: Bar = { id, number, startBarline, endBarline, ending, review };
  if (lineBreak !== undefined) bar.lineBreak = lineBreak;
  return bar;
}

function withVoice(staffBar: StaffBar | undefined, barId: Id, index: number, view: BarView): StaffBar {
  const base: StaffBar = staffBar ?? { barId, voices: [] };
  const content: Voice = { index, items: view.items, tuplets: view.tuplets };
  const exists = base.voices.some((voice) => voice.index === index);
  const voices = exists
    ? base.voices.map((voice) => (voice.index === index ? content : voice))
    : [...base.voices, content].sort((a, b) => a.index - b.index);
  return { ...base, voices };
}

function ensureStaff(score: Score, select: VoiceSelect): Score {
  if (staffOf(score, select) !== undefined) return score;
  if (select.staff !== undefined) throw new Error(`no staff ${select.staff}`);
  return { ...score, parts: defaultParts(score.bars.map((bar) => bar.id)) };
}

function harmonyEntry(view: BarView): HarmonyBar {
  return { barId: view.id, chords: view.chords, annotations: view.annotations };
}

/** Replace one bar, by id, with an edited view: grid entry, voice content and harmony all written back. */
export function withBarView(score: Score, view: BarView, select: VoiceSelect = {}): Score {
  const ready = ensureStaff(score, select);
  const target = staffOf(ready, select)!;
  const index = select.voice ?? FIRST_VOICE;
  const grid = gridBar(view);
  const hasHarmony = ready.harmony.some((entry) => entry.barId === view.id);
  return {
    ...ready,
    bars: ready.bars.map((bar) => (bar.id === view.id ? grid : bar)),
    harmony: hasHarmony
      ? ready.harmony.map((entry) => (entry.barId === view.id ? harmonyEntry(view) : entry))
      : [...ready.harmony, harmonyEntry(view)],
    parts: ready.parts.map((part) => ({
      ...part,
      staves: part.staves.map((staff) => {
        if (staff.id !== target.id) return staff;
        const present = staff.bars.some((staffBar) => staffBar.barId === view.id);
        return {
          ...staff,
          bars: present
            ? staff.bars.map((staffBar) =>
                staffBar.barId === view.id ? withVoice(staffBar, view.id, index, view) : staffBar,
              )
            : [...staff.bars, withVoice(undefined, view.id, index, view)],
        };
      }),
    })),
  };
}

/** Edit one bar's view by id. A missing bar is a no-op. */
export function mapBarView(
  score: Score,
  barId: Id,
  edit: (view: BarView) => BarView,
  select: VoiceSelect = {},
): Score {
  const view = findBarView(score, barId, select);
  return view === undefined ? score : withBarView(score, edit(view), select);
}

/**
 * Replace the whole grid with these views, in this order. Bars that are no longer present lose their staff content
 * and harmony; bars that are new get an empty entry in every staff; the selected voice takes each view's content.
 * What bar insert, delete, move and the importers need.
 */
export function withBarViews(score: Score, views: readonly BarView[], select: VoiceSelect = {}): Score {
  const ready = ensureStaff({ ...score, bars: score.bars }, select);
  const target = staffOf(ready, select)!;
  const index = select.voice ?? FIRST_VOICE;
  return {
    ...ready,
    bars: views.map(gridBar),
    harmony: views.map(harmonyEntry),
    parts: ready.parts.map((part) => ({
      ...part,
      staves: part.staves.map((staff) => {
        const existing = new Map(staff.bars.map((staffBar) => [staffBar.barId, staffBar]));
        return {
          ...staff,
          bars: views.map((view): StaffBar => {
            const had = existing.get(view.id);
            if (staff.id === target.id) return withVoice(had, view.id, index, view);
            return had ?? { barId: view.id, voices: [emptyVoice()] };
          }),
        };
      }),
    })),
  };
}

/** The text annotations of one bar, without building a whole view. */
export function annotationsOfBar(score: Score, barId: Id): Annotation[] {
  return score.harmony.find((entry) => entry.barId === barId)?.annotations ?? NO_TEXT;
}

/** The chord symbols of one bar, without building a whole view. */
export function chordsOfBar(score: Score, barId: Id): Chord[] {
  return score.harmony.find((entry) => entry.barId === barId)?.chords ?? NO_CHORDS;
}

// ---------------------------------------------------------------------------
// Structure queries (ADR-0041 slice 2): which staves and voices a score has
// ---------------------------------------------------------------------------

/** At most four voices to a staff (ADR-0041, accepted): stems up for voices 1 and 3, down for 2 and 4. */
export const MAX_VOICES = 4;

/** The voice indexes a staff has, ascending. A staff always has voice 1, even with no bars yet. */
export function voiceIndexes(staff: Staff): number[] {
  const seen = new Set<number>([FIRST_VOICE]);
  for (const staffBar of staff.bars) for (const voice of staffBar.voices) seen.add(voice.index);
  return [...seen].sort((a, b) => a - b);
}

/** Every staff and voice of the score, in part, staff, voice order. */
export function voiceSelects(score: Score): Required<VoiceSelect>[] {
  return allStaves(score).flatMap((staff) => voiceIndexes(staff).map((voice) => ({ staff: staff.id, voice })));
}

/** Whether a voice of a staff holds any note, rest or tuplet. */
export function voiceHoldsNotation(staff: Staff, index: number, barId?: Id): boolean {
  return staff.bars.some(
    (staffBar) =>
      (barId === undefined || staffBar.barId === barId) &&
      staffBar.voices.some((voice) => voice.index === index && (voice.items.length > 0 || voice.tuplets.length > 0)),
  );
}

/** Whether any voice of a staff holds notation. */
export function staffHoldsNotation(staff: Staff, barId?: Id): boolean {
  return voiceIndexes(staff).some((index) => voiceHoldsNotation(staff, index, barId));
}

/** Whether any staff holds notation in this bar: what `bar rm` must check, since a second staff counts. */
export function barHoldsNotation(score: Score, barId: Id): boolean {
  return allStaves(score).some((staff) => staffHoldsNotation(staff, barId));
}

/** The staff's clef at a bar: the latest change at or before it, else the opening clef. */
export function clefAt(score: Score, staff: Staff, barNumber: number): Clef {
  let clef = staff.clef;
  for (const bar of score.bars) {
    if (bar.number > barNumber) continue;
    const change = staff.bars.find((staffBar) => staffBar.barId === bar.id)?.clef;
    if (change !== undefined) clef = change;
  }
  return clef;
}

/** A view of every bar for every staff and voice, in `voiceSelects` order: what a metric or a transpose walks. */
export function allBarViews(score: Score): { select: Required<VoiceSelect>; views: BarView[] }[] {
  return voiceSelects(score).map((select) => ({ select, views: barViews(score, select) }));
}
