import { describe, expect, it } from 'vitest';
import { DEFAULT_KEY, DEFAULT_TIME, makeBar, makeScore, projectScore } from '@sibei/model';
import { layout } from '@sibei/layout';

/**
 * What a score carries when nobody said (KAN-594).
 *
 * `makeScore` defaulted a missing title to the string 'Untitled' until 2026-08-01, which destroyed
 * the one fact only creation knows: with the document as the truth (ADR-0028), a stored 'Untitled'
 * is indistinguishable from a chart somebody deliberately named that. Both surfaces already relied
 * on the distinction — the library italicises an unnamed chart and prints its id beside it, page 1's
 * title band collapses for one (KAN-525) — so the default was erasing at creation something two
 * features downstream were reading.
 *
 * These sit in one file because the decision has to hold at the *default*, not per client: the CLI
 * omits `title` from its create payload when `--title` is absent, and any third client that omits it
 * has to land on the same document or the surfaces disagree about a user-visible string (Q79).
 */

const blank = (init: Parameters<typeof makeScore>[0]) =>
  makeScore({ bars: [makeBar({ id: 'bar-1', number: 1 })], ...init });

describe('makeScore, on a missing title', () => {
  it('leaves the title empty rather than naming the chart', () => {
    expect(blank({ id: 'score-1' }).meta.title).toBe('');
  });

  it('keeps an explicit title, including one that is literally "Untitled"', () => {
    expect(blank({ id: 'score-1', title: 'Body and Soul' }).meta.title).toBe('Body and Soul');

    // The whole point of the change: this is now a *nameable* name, and it round-trips as one.
    expect(blank({ id: 'score-1', title: 'Untitled' }).meta.title).toBe('Untitled');
  });

  it('treats an explicit empty title the same as an absent one, so no client has to send it', () => {
    expect(blank({ id: 'score-1', title: '' })).toEqual(blank({ id: 'score-1' }));
  });

  it('defaults the rest of the metadata the way it always did', () => {
    // `composer` and `style` were already ''/null; the title was the odd one out, and this pins
    // that the fix made it consistent rather than making something else inconsistent.
    const meta = blank({ id: 'score-1' }).meta;
    expect(meta.composer).toBe('');
    expect(meta.style).toBeNull();
    expect(meta.key).toEqual(DEFAULT_KEY);
    expect(meta.time).toEqual(DEFAULT_TIME);
  });
});

describe('what a default-titled score looks like downstream', () => {
  it('collapses page 1 title band, exactly as an explicitly untitled chart does', () => {
    // Claim verified rather than assumed: KAN-525's derived band needs no work for this change,
    // because it keys off `meta.title === ''` and that is now what a missing title produces.
    const result = layout(blank({ id: 'score-1' }));

    expect(result.pages[0]?.header).toEqual([]);
    expect(result.pages[0]?.systems[0]?.y).toBe(result.pageSpec.margin.top);
  });

  it('prints a projection header with no dangling separator', () => {
    // The projection is a contract (ADR-0009), so the shape of this line is deliberate: the title
    // is omitted the way the composer and the style line already are, not printed as an empty cell.
    const first = projectScore(blank({ id: 'score-1' })).split('\n')[0];

    expect(first).toBe('key C, 4/4, 1 bars');
    expect(first?.startsWith('—')).toBe(false);
  });
});
