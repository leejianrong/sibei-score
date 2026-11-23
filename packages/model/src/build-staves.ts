import type { BarItem, BarView, Clef, Id, Part, Score, Staff, StaffBar, StaffType, Tuplet, Voice } from './score.js';
import type { ScoreInit } from './build.js';
import { makeScore } from './build.js';

/**
 * Builders for multi-staff, multi-voice scores (ADR-0041, SIB2-227). `makeScore` files everything into one part, one
 * staff and one voice; this takes that score and replaces its `parts`, so a test or a fixture can state a grand
 * staff, two voices on a staff, or a whole band without going through the ops that slice 2 adds.
 *
 * The grid and the harmony lane still come from `init.bars` (chords and text belong above the top staff,
 * ADR-0041 section 3). Each staff's own content is given per bar, as a list of voices.
 */

export interface VoiceInit {
  items: BarItem[];
  tuplets?: Tuplet[];
}

/** One staff's music: `bars[i]` is the voices of grid bar `i`, voice 1 first. A missing entry is an empty voice 1. */
export interface StaffInit {
  id?: Id;
  type?: StaffType;
  clef?: Clef;
  bars: (VoiceInit | VoiceInit[])[];
}

export interface PartInit {
  id?: Id;
  name?: string;
  shortName?: string;
  instrument?: number | null;
  transposition?: number;
  staves: StaffInit[];
}

export interface StaffedScoreInit extends Omit<ScoreInit, 'bars'> {
  /** The grid and the harmony lane. A bar's own `items` are ignored here: the parts carry the music. */
  bars: BarView[];
  parts: PartInit[];
}

/** A view's voice content, so a fixture can pass the `BarBuilder.build()` results it already has. */
export function voiceOfView(view: BarView): VoiceInit {
  return { items: view.items, tuplets: view.tuplets };
}

export function makeStaffedScore(init: StaffedScoreInit): Score {
  const base = makeScore({ ...init, bars: init.bars });
  let staffCount = 0;
  const parts: Part[] = init.parts.map(
    (part, partIndex): Part => ({
      id: part.id ?? `part-${partIndex + 1}`,
      name: part.name ?? '',
      ...(part.shortName === undefined ? {} : { shortName: part.shortName }),
      instrument: part.instrument ?? null,
      transposition: part.transposition ?? 0,
      staves: part.staves.map((staff): Staff => {
        staffCount += 1;
        return {
          id: staff.id ?? `staff-${staffCount}`,
          type: staff.type ?? 'standard',
          clef: staff.clef ?? (staff.type === 'percussion' ? 'percussion' : 'treble'),
          bars: base.bars.map((bar, index): StaffBar => {
            const entry = staff.bars[index];
            const voices = entry === undefined ? [{ items: [] }] : Array.isArray(entry) ? entry : [entry];
            return {
              barId: bar.id,
              voices: voices.map(
                (voice, voiceIndex): Voice => ({
                  index: voiceIndex + 1,
                  items: voice.items,
                  tuplets: voice.tuplets ?? [],
                }),
              ),
            };
          }),
        };
      }),
    }),
  );
  return { ...base, parts };
}
