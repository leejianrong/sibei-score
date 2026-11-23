import { barViews, transposePitch, transposeSpelling, voiceSelects, withBarViews } from '@sibei/model';
import type { Interval, KeySignature, Score } from '@sibei/model';
import { transposeChordText } from './transpose.js';

/**
 * Instrument parts as a **render-time view** (ADR-0016). The score always stores concert pitch; a
 * part is how that same sounding music is written down for a transposing instrument, produced at
 * render time and never stored. So `writtenPart` is a pure `Score -> Score` transform — the stored
 * document is untouched, which is the whole point of parts being views rather than the stored
 * variants they are so often mistaken for.
 *
 * It lives in `music` rather than the server, next to the chord-symbol transposition it depends on,
 * because both render surfaces need it: `@sibei/api`'s export path runs it before rendering a PDF,
 * and the browser runs it to preview a part on screen (V6e) — and the browser may not resolve
 * `@sibei/api`. Framework-free like the rest of `music`, for the same reason.
 *
 * This is the other half of V6, the mirror of the `transpose` *op*: transpose mutates the concert
 * key, a part re-writes without mutating. Both share the spelling engine and the chord-symbol
 * transposition, so the arithmetic lives in one place and only the "stored vs. viewed" decision
 * differs.
 */

/** The instruments a part can be written for, with `concert` — the score as stored — as the identity. */
export const PART_INSTRUMENTS = [
  'concert',
  'bb-trumpet',
  'bb-tenor',
  'eb-alto',
  'eb-bari',
  'f-horn',
] as const;

export type PartInstrument = (typeof PART_INSTRUMENTS)[number];

/**
 * Each instrument's transposition, as the interval from **concert (sounding) up to written** pitch,
 * carried with its octave (ADR-0016). The octave is the part that matters and the part most likely
 * to be got wrong: a tenor sax is written a major *ninth* above concert, not a major second, and
 * treating the interval as pitch-class-only would put the whole part an octave off — a mistake a
 * player spots on the first note. The bari is a major *thirteenth*, an octave above the alto's major
 * sixth, for the same reason.
 *
 * The written key signature and the chord roots move by the same interval; only the melody uses its
 * octave, because a key and a chord root have no octave to displace.
 */
const PART_INTERVALS: Record<Exclude<PartInstrument, 'concert'>, Interval> = {
  'bb-trumpet': { letterSteps: 1, semitones: 2 }, // M2 up
  'bb-tenor': { letterSteps: 8, semitones: 14 }, // M9 up (an octave above the trumpet)
  'eb-alto': { letterSteps: 5, semitones: 9 }, // M6 up
  'eb-bari': { letterSteps: 12, semitones: 21 }, // M13 up (an octave above the alto)
  'f-horn': { letterSteps: 4, semitones: 7 }, // P5 up
};

/** The interval an instrument's part is written at, or `null` for the concert score (no transform). */
export function partInterval(instrument: PartInstrument): Interval | null {
  return instrument === 'concert' ? null : PART_INTERVALS[instrument];
}

/** A reader's name for each part, for a download filename and the UI's part picker. */
const PART_LABELS: Record<PartInstrument, string> = {
  concert: 'Concert',
  'bb-trumpet': 'Bb Trumpet',
  'bb-tenor': 'Bb Tenor',
  'eb-alto': 'Eb Alto',
  'eb-bari': 'Eb Bari',
  'f-horn': 'F Horn',
};

export function partLabel(instrument: PartInstrument): string {
  return PART_LABELS[instrument];
}

/**
 * The spelled interval from sounding up to written for a part's `transposition` in semitones (ADR-0041): the letter
 * count is the textbook interval for each of the twelve (a tritone is a diminished fifth), carried with its octaves.
 * Negative semitones are a part written lower than it sounds (a piccolo).
 */
export function intervalOfSemitones(semitones: number): Interval {
  const letters = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6];
  const sign = semitones < 0 ? -1 : 1;
  const abs = Math.abs(semitones);
  return { letterSteps: sign * ((letters[abs % 12] as number) + 7 * Math.floor(abs / 12)), semitones };
}

/**
 * The written version of a score for one instrument. The melody moves by the full interval
 * (octave included) and is respelled by the written key signature; the key signature itself and the
 * chord roots move by the same interval (ADR-0017). Note pins are honoured, exactly as under the
 * concert-key `transpose` op — a part is a different presentation of the same music, not a different
 * spelling policy.
 *
 * Every staff and voice moves (ADR-0041 slice 5a), the chord lane once, and a percussion staff never (its pitches
 * are only places on the staff). A part that carries its own `transposition` is already an instrument's part, so it
 * moves by that interval rather than the requested instrument's, and comes back with `transposition: 0` — the
 * transposition is applied, and a reader that applied it again would be wrong. (A view has one key signature, the
 * requested instrument's, so such a part's own key is not drawn: per-part keys wait on the engraver.)
 *
 * `concert` returns the score untouched, so a caller can ask for a part unconditionally and the
 * identity case costs nothing — and a part's own transposition is then left for the MusicXML codec, which
 * writes it as a `<transpose>`. Metric validity is a function of rhythm, which transposition does not
 * change, so the bars' review flags carry over as they are.
 */
export function writtenPart(score: Score, instrument: PartInstrument): Score {
  const interval = partInterval(instrument);
  if (interval === null) return score;

  const key = writtenKey(score.meta.key, interval);
  const staves = new Map<string, { interval: Interval; key: KeySignature; percussion: boolean }>();
  for (const part of score.parts) {
    const own = part.transposition === 0 ? null : intervalOfSemitones(part.transposition);
    for (const staff of part.staves) {
      staves.set(staff.id, {
        interval: own ?? interval,
        key: own === null ? key : writtenKey(score.meta.key, own),
        percussion: staff.type === 'percussion',
      });
    }
  }

  let out: Score = { ...score, meta: { ...score.meta, key } };
  voiceSelects(score).forEach((select, index) => {
    const how = staves.get(select.staff);
    if (how === undefined) return;
    const views = barViews(out, select).map((bar) => ({
      ...bar,
      items: how.percussion
        ? bar.items
        : bar.items.map((item) =>
            item.kind === 'note'
              ? {
                  ...item,
                  pitch: transposePitch(item.pitch, how.interval, how.key, item.spellingPinned),
                  ...(item.graces === undefined
                    ? {}
                    : {
                        graces: item.graces.map((grace) => ({
                          ...grace,
                          pitch: transposePitch(grace.pitch, how.interval, how.key, false),
                        })),
                      }),
                }
              : item,
          ),
      // The chord lane is shared by every staff: the first pass moves it, the others carry it as it is.
      chords:
        index === 0
          ? bar.chords.map((chord) => ({ ...chord, text: transposeChordText(chord.text, interval, key, chord.spellingPinned) }))
          : bar.chords,
    }));
    out = withBarViews(out, views, select);
  });
  // The own transposition of a part is now applied.
  return { ...out, parts: out.parts.map((part) => (part.transposition === 0 ? part : { ...part, transposition: 0 })) };
}

/**
 * The written key signature: the concert tonic moved by the interval, keeping its mode. The tonic
 * rides the interval rather than being re-spelled by some other key — a Bb instrument reading a
 * concert-Eb chart is in F, always F and never E# — so this is the interval-preserving (pinned)
 * transposition, the same one that carries a pinned note.
 */
function writtenKey(concert: KeySignature, interval: Interval): KeySignature {
  const tonic = transposeSpelling({ step: concert.tonic, alter: concert.alter }, interval, concert, true);
  return { tonic: tonic.step, alter: tonic.alter, mode: concert.mode };
}
