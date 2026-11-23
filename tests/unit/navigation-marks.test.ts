import { describe, expect, it } from 'vitest';
import { applyOperation, replay } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { navigationChart } from '@sibei/fixtures';
import { NAV_BAND, layout } from '@sibei/layout';
import { NAV_KINDS, NAV_TEXT, projectScore } from '@sibei/model';
import type { NavKind, Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';

/** Navigation marks (SIB2-175, ADR-0021 amendment): `nav.set|rm`, the projection, layout, the engraver, MusicXML. */

function run(operations: Operation[]): { score: Score; log: Operation[] } {
  const log: Operation[] = [];
  let score: Score | null = null;
  for (const operation of operations) {
    const applied = applyOperation(score, operation);
    score = applied.score;
    log.push(applied.operation);
  }
  if (score === null) throw new Error('no score');
  return { score, log };
}

const create: Operation = { type: 'score.create', payload: { id: 'c', barCount: 8 } };
const set = (bar: number, kind: NavKind): Operation => ({ type: 'nav.set', target: `bar${bar}`, payload: { kind } });
const rm = (bar: number, kind?: NavKind): Operation => ({ type: 'nav.rm', target: `bar${bar}`, payload: kind === undefined ? {} : { kind } });
const navOf = (score: Score, bar: number): NavKind[] | undefined => score.bars.find((b) => b.number === bar)?.nav;

describe('nav.set and nav.rm', () => {
  it('sets a mark, keeps the kinds in canonical order, and replays', () => {
    const { score, log } = run([create, set(3, 'fine'), set(3, 'coda'), set(3, 'segno')]);
    expect(navOf(score, 3)).toEqual(['segno', 'coda', 'fine']);
    expect(replay(log)).toEqual(score);
  });

  it('holds one jump text per bar: a second jump replaces the first, a sign stays', () => {
    const { score } = run([create, set(2, 'segno'), set(2, 'ds'), set(2, 'ds-al-coda')]);
    expect(navOf(score, 2)).toEqual(['segno', 'ds-al-coda']);
  });

  it('refuses a mark the bar already has, an unknown kind, and a bar that does not exist', () => {
    expect(() => run([create, set(1, 'segno'), set(1, 'segno')])).toThrow(/already has segno/);
    expect(() => run([create, { type: 'nav.set', target: 'bar1', payload: { kind: 'repeat' as NavKind } }])).toThrow(/navigation mark/);
    expect(() => run([create, set(99, 'segno')])).toThrow();
  });

  it('removes one mark, or every mark, and leaves no empty field behind', () => {
    const one = run([create, set(1, 'segno'), set(1, 'fine'), rm(1, 'segno')]).score;
    expect(navOf(one, 1)).toEqual(['fine']);
    const all = run([create, set(1, 'segno'), set(1, 'fine'), rm(1)]).score;
    expect(Object.keys(all.bars[0]!)).not.toContain('nav');
    expect(() => run([create, rm(1)])).toThrow(/nothing to remove/);
    expect(() => run([create, set(1, 'fine'), rm(1, 'coda')])).toThrow(/nothing to remove/);
  });

  it('a chart without marks has no nav field at all (ADR-0028)', () => {
    expect(run([create]).score.bars.every((bar) => !('nav' in bar))).toBe(true);
  });
});

describe('the projection', () => {
  it('lists the marks with the bar addresses nav rm takes, and says nothing for a chart without', () => {
    const { score } = run([create, set(1, 'segno'), set(4, 'ds-al-coda')]);
    expect(projectScore(score)).toContain('navigation: segno at bar1, ds-al-coda at bar4');
    expect(projectScore(run([create]).score)).not.toContain('navigation');
  });
});

describe('layout', () => {
  it('reserves a row above the staff only for a system that carries a mark', () => {
    const marked = navigationChart();
    const bare: Score = { ...marked, bars: marked.bars.map(({ nav: _nav, ...rest }) => rest) };
    const before = layout(bare).pages[0]!.systems;
    const after = layout(marked).pages[0]!.systems;
    expect(after.map((system) => system.aboveStaff)).toEqual(before.map((system) => system.aboveStaff + NAV_BAND));
    const items = after[0]!.bars[0]!.items.filter((item) => item.kind === 'nav');
    expect(items).toEqual([{ kind: 'nav', nav: 'segno' }]);
    const unmarked = layout(run([create]).score).pages[0]!.systems;
    expect(unmarked.every((system) => system.bars.every((bar) => bar.items.every((item) => item.kind !== 'nav')))).toBe(true);
  });
});

describe('the engraver', () => {
  const svg = (score: Score): string => renderScoreToSvg(score).map((page) => page.svg).join('\n');

  it('draws the segno and coda as glyphs and each jump as its own text, bold italic', () => {
    const out = svg(navigationChart());
    for (const kind of NAV_KINDS) {
      const text = NAV_TEXT[kind];
      if (text !== undefined && navigationChart().bars.some((bar) => bar.nav?.includes(kind))) expect(out).toContain(`>${text}<`);
    }
    expect(out).toContain('class="se-nav"');
    expect(out).toMatch(/class="se-nav"[^>]*font-weight="bold"[^>]*font-style="italic"/);
    expect(svg(run([create]).score)).not.toContain('se-nav');
  });

  it('a chart without marks is drawn exactly as before', () => {
    // The unmarked system's geometry must not move: marks add a row, they never shift a chart that has none.
    const without = run([create]).score;
    expect(svg(without)).toBe(svg(run([create, set(1, 'segno'), rm(1)]).score));
  });
});

describe('MusicXML', () => {
  it('writes the sign, the words and the sound a player follows', () => {
    const xml = scoreToMusicXml(navigationChart());
    expect(xml).toContain('<segno/>');
    expect(xml).toContain('<coda/>');
    expect(xml).toContain('<words>D.S. al Coda</words>');
    expect(xml).toContain('dalsegno="segno"');
    expect(xml).toContain('tocoda="coda"');
    expect(xml).toContain('fine="yes"');
    expect(xml).toContain('dacapo="yes"');
  });

  it('round trips every kind, and the words are not left behind as a text direction', () => {
    const marks: Operation[] = NAV_KINDS.filter((kind) => kind !== 'ds' && kind !== 'dc').map((kind, i) => set(i + 1, kind));
    const { score } = run([{ type: 'score.create', payload: { id: 'c', barCount: 12 } }, ...marks, set(11, 'ds'), set(12, 'dc')]);
    const { score: back, warnings } = musicXmlToScore(scoreToMusicXml(score), { id: 'c' });
    expect(warnings).toEqual([]);
    expect(back.bars.map((bar) => bar.nav)).toEqual(score.bars.map((bar) => bar.nav));
    expect(back.harmony.flatMap((entry) => entry.annotations)).toEqual([]);
  });

  it('reads printed words with no <sound> as the mark, and ignores a tempo <sound>', () => {
    const base = scoreToMusicXml(run([create]).score);
    const withWords = base.replace('<measure number="1">', '<measure number="1"><direction placement="above"><direction-type><words>D.S. al Fine</words></direction-type></direction>');
    expect(navOf(musicXmlToScore(withWords, { id: 'c' }).score, 1)).toEqual(['ds-al-fine']);
    const tempo = base.replace('<measure number="1">', '<measure number="1"><direction><direction-type><words>Swing</words></direction-type><sound tempo="120"/></direction>');
    const read = musicXmlToScore(tempo, { id: 'c' }).score;
    expect(navOf(read, 1)).toBeUndefined();
    expect(read.harmony.flatMap((entry) => entry.annotations).map((a) => a.text)).toEqual(['Swing']);
  });
});
