import {
  MAX_VERSES,
  SYLLABICS,
  allStaves,
  barView,
  lyricTextProblem,
  orderedItems,
  parseLyricText,
  resolveAddress,
  splitSyllable,
  voiceIndexes,
} from '@sibei/model';
import type { BarItem, BarView, Id, Lyric, Note, Score, VoiceSelect } from '@sibei/model';
import { OperationError } from './errors.js';
import type { LyricRmPayload, LyricSetPayload, LyricsSetPayload } from './operations.js';
import type { Applied } from './apply.js';

/**
 * Lyric syllables (SIB2-273, ADR-0021 amendment): `lyric.set|rm` for one note and `lyrics.set`, which distributes a
 * whole verse over the notes of a bar range. A lyric is part of its note, so none of this touches a bar's rhythm (ADR-0013),
 * and removing a note takes its lyrics with it.
 */

type Rewrite = (score: Score, barId: Id, change: (bar: BarView) => BarView, select: VoiceSelect) => Score;

function fail(detail: string): never {
  throw new OperationError({ kind: 'validation', detail });
}

function verseOf(raw: unknown): number {
  const verse = raw === undefined ? 1 : raw;
  if (typeof verse !== 'number' || !Number.isInteger(verse) || verse < 1 || verse > MAX_VERSES) {
    return fail(`a verse is a whole number from 1 to ${MAX_VERSES}, not ${JSON.stringify(raw)}`);
  }
  return verse;
}

/** `lyrics` with `lyric` put in its verse, kept in verse order. */
function withLyric(lyrics: readonly Lyric[] | undefined, lyric: Lyric): Lyric[] {
  return [...(lyrics ?? []).filter((other) => other.verse !== lyric.verse), lyric].sort((a, b) => a.verse - b.verse);
}

/** A note with this verse's syllable taken off (`undefined` verse: every verse), and no empty field left behind. */
function withoutVerse(note: Note, verse: number | undefined): Note {
  const kept = verse === undefined ? [] : (note.lyrics ?? []).filter((lyric) => lyric.verse !== verse);
  const { lyrics: _gone, ...rest } = note;
  return kept.length === 0 ? rest : { ...rest, lyrics: kept };
}

export function setLyric(score: Score, target: string, payload: LyricSetPayload, rewrite: Rewrite): Applied {
  const verse = verseOf(payload?.verse);
  // `hel-` and `-lo` carry their position in the word; an explicit `syllabic` wins and the text is taken as typed.
  const split = payload?.syllabic === undefined && typeof payload?.text === 'string' ? splitSyllable(payload.text) : null;
  const text = split === null ? payload?.text : split.text;
  const syllabic = payload?.syllabic ?? split?.syllabic ?? 'single';
  const problem = lyricTextProblem(text);
  if (problem !== null) fail(problem);
  if (!SYLLABICS.includes(syllabic)) fail(`a syllable is ${SYLLABICS.join(', ')}, not ${JSON.stringify(syllabic)}`);
  const resolved = resolveAddress(score, target, 'note');
  const note = resolved.target as Note;
  const lyric: Lyric = { verse, text: text as string, syllabic, ...(payload?.extend === true ? { extend: true as const } : {}) };
  const updated: Note = { ...note, lyrics: withLyric(note.lyrics, lyric) };
  return {
    score: rewrite(score, resolved.bar.id, (bar) => ({ ...bar, items: bar.items.map((item) => (item.id === note.id ? updated : item)) }), resolved.select),
    operation: { type: 'lyric.set', target, payload },
    changed: [note.id],
  };
}

export function removeLyric(score: Score, target: string, payload: LyricRmPayload | undefined, rewrite: Rewrite): Applied {
  const verse = payload?.verse === undefined ? undefined : verseOf(payload.verse);
  const resolved = resolveAddress(score, target, 'note');
  const note = resolved.target as Note;
  if (note.lyrics === undefined || (verse !== undefined && !note.lyrics.some((lyric) => lyric.verse === verse))) {
    fail(`${target} has no ${verse === undefined ? 'lyric' : `verse ${verse} lyric`}, so there is nothing to remove`);
  }
  const updated = withoutVerse(note, verse);
  return {
    score: rewrite(score, resolved.bar.id, (bar) => ({ ...bar, items: bar.items.map((item) => (item.id === note.id ? updated : item)) }), resolved.select),
    operation: { type: 'lyric.rm', target, payload: payload ?? {} },
    changed: [note.id],
  };
}

/**
 * `lyrics.set`: one verse of text over bars `first` to `last` of one voice of a staff. The verse's existing syllables
 * in that stretch go first, so the op is a decision about the stretch. Notes are taken in reading order; a rest has no
 * syllable and is skipped, and so is a note tied from the one before it (it sustains the same syllable). More syllables
 * than notes is refused with both counts, fewer leaves the remaining notes bare.
 */
export function setLyrics(score: Score, payload: LyricsSetPayload, rewrite: Rewrite): Applied {
  const staves = allStaves(score);
  const staffName = payload?.staff ?? 's1';
  const reference = typeof staffName === 'string' ? /^s(\d+)$/.exec(staffName) : null;
  const staff = reference === null ? undefined : staves[Number(reference[1]) - 1];
  if (staff === undefined) return fail(`lyrics go on a staff like s1; ${JSON.stringify(staffName)} is not one of this chart's ${staves.length}`);
  const voice = payload.voice ?? 1;
  if (!voiceIndexes(staff).includes(voice)) fail(`staff ${staffName} has no voice ${voice}`);
  const verse = verseOf(payload.verse);
  if (!Number.isInteger(payload.first) || !Number.isInteger(payload.last) || payload.first > payload.last) {
    fail('lyrics.set takes whole bar numbers, first not after last');
  }
  const bars = score.bars.filter((bar) => bar.number >= payload.first && bar.number <= payload.last);
  if (bars.length === 0) fail(`there are no bars from ${payload.first} to ${payload.last}`);
  const parsed = parseLyricText(typeof payload.text === 'string' ? payload.text : '');
  if (!parsed.ok) return fail(parsed.detail);

  const which = { staff: staff.id, voice };
  const slots = parsed.slots;
  const carriers: { bar: Id; note: Id }[] = [];
  for (const bar of bars) {
    for (const item of orderedItems(barView(score, bar, which))) {
      if (item.kind === 'note' && item.tie !== 'stop' && item.tie !== 'both') carriers.push({ bar: bar.id, note: item.id });
    }
  }
  if (slots.length > carriers.length) {
    fail(`${slots.length} syllables for ${carriers.length} notes in bars ${payload.first}-${payload.last}; add notes, shorten the text, or widen the range`);
  }
  const assigned = new Map<Id, Lyric>();
  slots.forEach((slot, index) => {
    const carrier = carriers[index];
    if (carrier === undefined || slot.skip) return;
    assigned.set(carrier.note, { verse, text: slot.text, syllabic: slot.syllabic, ...(slot.extend === true ? { extend: true as const } : {}) });
  });

  let current = score;
  const changed: Id[] = [];
  for (const bar of bars) {
    current = rewrite(
      current,
      bar.id,
      (view) => ({
        ...view,
        items: view.items.map((item: BarItem): BarItem => {
          if (item.kind !== 'note') return item;
          const lyric = assigned.get(item.id);
          const cleared = withoutVerse(item, verse);
          if (lyric === undefined) {
            if (cleared !== item && (item.lyrics ?? []).some((l) => l.verse === verse)) changed.push(item.id);
            return cleared;
          }
          changed.push(item.id);
          return { ...cleared, lyrics: withLyric(cleared.lyrics, lyric) };
        }),
      }),
      which,
    );
  }
  return { score: current, operation: { type: 'lyrics.set', payload: { ...payload } }, changed };
}
