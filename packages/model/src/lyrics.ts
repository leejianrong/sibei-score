import { MAX_LYRIC_LENGTH } from './score.js';
import type { Lyric, Syllabic } from './score.js';

/**
 * Reading lyric text (SIB2-273, ADR-0021 amendment). Plain TypeScript, no framework: the op applier distributes a verse
 * onto notes with it, the CLI splits one syllable with it, and the browser's bar-range field shares it, so the three
 * agree on what "hel-lo" means.
 *
 * The notation is the one a singer already writes: words by spaces, syllables of a word by hyphens (`hel-lo` or
 * `hel - lo`), and `_` for a note the previous syllable is held over (a melisma, drawn as an extender line).
 */

/** One slot of a verse: a syllable for a note, or a note the previous syllable is held over (`_`). */
export type LyricSlot = { skip: false; text: string; syllabic: Syllabic; extend?: true } | { skip: true };

export type LyricParse = { ok: true; slots: LyricSlot[] } | { ok: false; detail: string };

/** A syllable's own text: no whitespace or control characters, not empty, within `MAX_LYRIC_LENGTH`. */
export function lyricTextProblem(text: unknown): string | null {
  if (typeof text !== 'string' || text.trim() === '') return 'a lyric syllable needs text';
  if (text.length > MAX_LYRIC_LENGTH) return `a lyric syllable is at most ${MAX_LYRIC_LENGTH} characters, not ${text.length}`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(text)) return 'a lyric syllable has no control characters';
  return null;
}

/**
 * Split a verse into slots, one per note. Hyphens inside a word and a hyphen standing alone between two words both
 * join syllables; a word of one syllable is `single`, a longer one runs `begin`, `middle`..., `end`. A token `_` is a
 * held note: it takes a note, writes nothing, and gives the syllable before it an extender line.
 */
export function parseLyricText(raw: string): LyricParse {
  const normalised = raw.replace(/\s*-\s*/g, '-').trim();
  if (normalised === '') return { ok: false, detail: 'there is no lyric text to distribute' };
  const slots: LyricSlot[] = [];
  for (const word of normalised.split(/\s+/)) {
    if (word === '_') {
      const previous = [...slots].reverse().find((slot) => !slot.skip);
      if (previous !== undefined && !previous.skip) previous.extend = true;
      slots.push({ skip: true });
      continue;
    }
    const parts = word.split('-').filter((part) => part !== '');
    for (const [index, text] of parts.entries()) {
      const problem = lyricTextProblem(text);
      if (problem !== null) return { ok: false, detail: problem };
      const syllabic: Syllabic = parts.length === 1 ? 'single' : index === 0 ? 'begin' : index === parts.length - 1 ? 'end' : 'middle';
      slots.push({ skip: false, text, syllabic });
    }
  }
  return { ok: true, slots };
}

/**
 * One syllable typed on its own: `hel-` begins a word, `-lo` ends one, `-l-` is a middle, `la` is a whole word. The
 * hyphens are read off the ends and dropped from the text.
 */
export function splitSyllable(raw: string): { text: string; syllabic: Syllabic } {
  const lead = raw.startsWith('-');
  const trail = raw.endsWith('-') && raw.length > 1;
  const text = raw.replace(/^-/, '').replace(/-$/, '');
  return { text, syllabic: lead && trail ? 'middle' : lead ? 'end' : trail ? 'begin' : 'single' };
}

/** A syllable as it is read back: the hyphens `splitSyllable` took off, so `show` and the editor round trip. */
export function formatSyllable(lyric: Pick<Lyric, 'text' | 'syllabic'>): string {
  const lead = lyric.syllabic === 'middle' || lyric.syllabic === 'end' ? '-' : '';
  const trail = lyric.syllabic === 'middle' || lyric.syllabic === 'begin' ? '-' : '';
  return `${lead}${lyric.text}${trail}`;
}
