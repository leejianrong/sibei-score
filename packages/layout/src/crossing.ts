import type { Duration, Id, OctaveShift, Pitch } from '@sibei/model';
import { STEPS } from '@sibei/model';
import { writtenPitch } from './ottava.js';

/**
 * Voices that cross (ADR-0041, SIB2-233). Numbered voices stem by number (1 and 3 up, 2 and 4 down), which is right
 * until the upper voice's note at an onset lies *below* the lower voice's: the up stem then runs up through the other
 * head and the down stem down through it. Gould's remedy is to let the stems point away from each other for that
 * moment, whatever the voices' numbers say, so the higher of the two heads takes the up stem and the lower the down one.
 *
 * Only a stem that can turn on its own is turned: a quarter or longer, outside a tuplet. A beamed note shares its group's
 * direction and a bracket reads it, so a crossing at a beamed note is left as numbered.
 */
export interface CrossingNote {
  id: Id;
  onset: number;
  pitch: Pitch;
  duration: Duration;
  /** Set for a tuplet's member. */
  tupletId?: Id | null;
}

export interface CrossingVoice {
  index: number;
  notes: readonly CrossingNote[];
}

function written(note: CrossingNote, shifts: ReadonlyMap<Id, OctaveShift> | undefined): number {
  const pitch = writtenPitch(note.pitch, shifts?.get(note.id));
  return pitch.octave * 7 + STEPS.indexOf(pitch.step);
}

function turnable(note: CrossingNote): boolean {
  return note.duration.value >= 2 && note.duration.value < 8 && (note.tupletId ?? null) === null;
}

/**
 * The notes whose numbered stem direction is reversed because their voice crosses another at that onset. Voices pair
 * as 1 with 2 and 3 with 4, the pairs that stem apart; a crossing is the odd voice (up) lying below the even one (down).
 * `shifts` is the ottava map, so a note under an 8va is compared where it is drawn.
 */
export function crossingFlips(
  voices: readonly CrossingVoice[],
  shifts?: ReadonlyMap<Id, OctaveShift>,
): Set<Id> {
  const flips = new Set<Id>();
  if (voices.filter((voice) => voice.notes.length > 0).length < 2) return flips;
  for (const upper of voices) {
    if (upper.index % 2 !== 1) continue;
    const lower = voices.find((voice) => voice.index === upper.index + 1);
    if (lower === undefined) continue;
    for (const a of upper.notes) {
      const b = lower.notes.find((note) => note.onset === a.onset);
      if (b === undefined || !turnable(a) || !turnable(b)) continue;
      if (written(a, shifts) < written(b, shifts)) {
        flips.add(a.id);
        flips.add(b.id);
      }
    }
  }
  return flips;
}
