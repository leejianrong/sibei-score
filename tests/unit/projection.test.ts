import { describe, expect, it } from 'vitest';
import {
  TICKS_PER_QUARTER,
  dur,
  formatPitch,
  makeAnnotation,
  makeBar,
  makeChord,
  makeNote,
  makeRest,
  makeScore,
  projectScore,
  resolveAddress,
} from '@sibei/model';
import type { Bar, Score } from '@sibei/model';
import { nastyChart } from '@sibei/fixtures';

/**
 * The text projection (ADR-0009). A **contract** — agents will depend on the format, so it gets its
 * own tests rather than being whatever the formatter happens to do this week.
 */

const Q = TICKS_PER_QUARTER;

function chart(bars: Bar[], meta: Partial<Parameters<typeof makeScore>[0]> = {}): Score {
  return makeScore({ id: 'score-1', title: 'Body and Soul', bars, ...meta });
}

const lines = (score: Score) => projectScore(score).split('\n');
const find = (score: Score, needle: string) =>
  lines(score).find((line) => line.includes(needle)) ?? '';

describe('the header', () => {
  it('names the tune, the key, the meter and the length', () => {
    const score = chart([makeBar({ id: 'bar-1', number: 1 })], {
      key: { tonic: 'D', alter: -1, mode: 'major' },
    });
    expect(lines(score)[0]).toBe('Body and Soul — key Db, 4/4, 1 bars');
  });

  it('includes the composer when there is one', () => {
    const score = chart([], { composer: 'Johnny Green' });
    expect(lines(score)[0]).toBe('Body and Soul — Johnny Green — key C, 4/4, 0 bars');
  });

  it('omits the title when the chart has none, rather than printing an empty cell', () => {
    // A deliberate change to an ADR-0009 contract, forced by KAN-594: an unnamed chart is now what
    // a plain `sbscore new` produces, so this line had to stop opening with a dangling em-dash.
    const score = chart([makeBar({ id: 'bar-1', number: 1 })], { title: '', composer: 'Johnny Green' });
    expect(lines(score)[0]).toBe('Johnny Green — key C, 4/4, 1 bars');
  });

  it('includes the style line when there is one', () => {
    expect(lines(chart([], { style: 'Ballad' }))[0]).toMatch(/— Ballad$/);
  });

  it('does not count the pickup as a bar, because a musician does not', () => {
    const score = chart([
      makeBar({ id: 'bar-0', number: 0 }),
      makeBar({ id: 'bar-1', number: 1 }),
      makeBar({ id: 'bar-2', number: 2 }),
    ]);
    expect(lines(score)[0]).toContain('2 bars');
  });
});

describe('the four-bar grid', () => {
  /** Eight bars, one chord each, so the row boundaries are unambiguous. */
  function eightBars(): Score {
    return chart(
      Array.from({ length: 8 }, (_, index) =>
        makeBar({
          id: `bar-${index + 1}`,
          number: index + 1,
          chords: [makeChord({ id: `chord-${index + 1}`, onset: 0, text: `C${index + 1}` })],
        }),
      ),
    );
  }

  it('breaks every four bars, matching the printed layout', () => {
    // A strictly line-per-bar format would parse more easily and was rejected anyway: the four-bar
    // grouping is what a reader takes structure from.
    const rows = lines(eightBars()).filter((line) => line.includes('|'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('C1');
    expect(rows[0]).toContain('C4');
    expect(rows[0]).not.toContain('C5');
    expect(rows[1]).toContain('C5');
  });

  it('labels each row with the bar it starts on', () => {
    const rows = lines(eightBars()).filter((line) => line.includes('|'));
    expect(rows[0]?.startsWith(' 1 |')).toBe(true);
    expect(rows[1]?.startsWith(' 5 |')).toBe(true);
  });

  it('finishes a short last row rather than padding it', () => {
    const score = chart(
      Array.from({ length: 6 }, (_, index) => makeBar({ id: `bar-${index + 1}`, number: index + 1 })),
    );
    const rows = lines(score).filter((line) => line.includes('|'));
    expect(rows).toHaveLength(2);
    // Four cells then a closing bar, versus two cells then a closing bar.
    expect((rows[0]?.match(/\|/g) ?? []).length).toBe(5);
    expect((rows[1]?.match(/\|/g) ?? []).length).toBe(3);
  });

  it('puts the pickup outside the grid, the way the page does', () => {
    const score = chart([
      makeBar({
        id: 'bar-0',
        number: 0,
        items: [makeNote({ id: 'note-1', onset: 3 * Q, duration: dur(4), pitch: 'G4' })],
      }),
      makeBar({ id: 'bar-1', number: 1 }),
    ]);
    expect(find(score, 'pickup')).toMatch(/^pickup \|/);
    expect(find(score, 'bar0')).toContain('n1 g4/4');
  });
});

describe('chord symbols carry beat placement', () => {
  it('places two chords in one bar at their beats', () => {
    // Routine in a jazz chart, and where in the bar a chord falls is musical information.
    const score = chart([
      makeBar({
        id: 'bar-1',
        number: 1,
        chords: [
          makeChord({ id: 'chord-1', onset: 0, text: 'Ebm7' }),
          makeChord({ id: 'chord-2', onset: 2 * Q, text: 'Ab7' }),
        ],
      }),
    ]);
    const row = find(score, 'Ebm7');
    expect(row.indexOf('Ebm7')).toBeLessThan(row.indexOf('Ab7'));
    // Beat 3 of 4 is about halfway across the cell.
    expect(row.indexOf('Ab7')).toBeGreaterThan(row.indexOf('Ebm7') + 4);
  });

  it('never lets two symbols run together, even when the bar is crowded', () => {
    // The bug this exists for: bar 10 of the nasty chart came out as `F#m7bB7`, two chords fused
    // into one nonsense symbol, because the width was computed before the placement.
    const score = chart([
      makeBar({
        id: 'bar-1',
        number: 1,
        chords: [
          makeChord({ id: 'chord-1', onset: 0, text: 'F#m7b5' }),
          makeChord({ id: 'chord-2', onset: 2 * Q, text: 'B7' }),
        ],
      }),
    ]);
    expect(find(score, 'F#m7b5')).toContain('F#m7b5 B7');
  });

  it('keeps every symbol of the nasty chart legible', () => {
    const projection = projectScore(nastyChart());
    for (const bar of nastyChart().bars) {
      for (const chord of bar.chords) expect(projection).toContain(chord.text);
    }
    // And no symbol is glued to the next: every `|`-delimited cell splits on whitespace into
    // exactly the symbols that bar holds.
    for (const row of projection.split('\n').filter((line) => /^\s*(\d+|pickup) \|/.test(line))) {
      for (const cell of row.slice(row.indexOf('|') + 1).split('|')) {
        for (const token of cell.trim().split(/\s+/).filter(Boolean)) {
          expect(token).not.toMatch(/^[A-G].*[A-G][#b]?\d/);
        }
      }
    }
  });

  it('marks a flagged chord', () => {
    const score = chart([
      makeBar({
        id: 'bar-1',
        number: 1,
        chords: [
          makeChord({
            id: 'chord-1',
            onset: 0,
            text: 'Ebm7',
            review: { flagged: true, reasons: ['unparsed-chord'] },
          }),
        ],
      }),
    ]);
    expect(find(score, 'Ebm7')).toContain('Ebm7!');
  });
});

describe('the melody line', () => {
  function aBar(items: Bar['items'], extra: Partial<Parameters<typeof makeBar>[0]> = {}): Score {
    return chart([makeBar({ id: 'bar-1', number: 1, items, ...extra })]);
  }

  it('lists each item with its ordinal address and its duration', () => {
    const score = aBar([
      makeNote({ id: 'note-1', onset: 0, duration: dur(8), pitch: 'Db5' }),
      makeNote({ id: 'note-2', onset: Q / 2, duration: dur(8), pitch: 'Eb5' }),
      makeNote({ id: 'note-3', onset: Q, duration: dur(4), pitch: 'F5' }),
    ]);
    expect(find(score, 'bar1')).toContain('n1 db5/8  n2 eb5/8  n3 f5/4');
  });

  it('prints a dotted duration with a dot', () => {
    const score = aBar([makeNote({ id: 'note-1', onset: 0, duration: dur(2, 1), pitch: 'G5' })]);
    expect(find(score, 'bar1')).toContain('n1 g5/2.');
  });

  it('prints a rest as r, and gives it an ordinal slot', () => {
    // A rest is a first-class object (Q35) and takes an nK slot, which is what makes it addressable
    // by position at all — see the resolver agreement test below.
    const score = aBar([
      makeNote({ id: 'note-1', onset: 0, duration: dur(4), pitch: 'Bb5' }),
      makeRest({ id: 'rest-1', onset: Q, duration: dur(4) }),
      makeNote({ id: 'note-2', onset: 2 * Q, duration: dur(2), pitch: 'C6' }),
    ]);
    expect(find(score, 'bar1')).toContain('n1 bb5/4  n2 r/4  n3 c6/2');
  });

  it('marks a tie with ~ on the side it points', () => {
    const score = chart([
      makeBar({
        id: 'bar-1',
        number: 1,
        items: [makeNote({ id: 'note-1', onset: 0, duration: dur(1), pitch: 'Eb5', tie: 'start' })],
      }),
      makeBar({
        id: 'bar-2',
        number: 2,
        items: [makeNote({ id: 'note-2', onset: 0, duration: dur(1), pitch: 'Eb5', tie: 'stop' })],
      }),
    ]);
    expect(find(score, 'bar1')).toContain('n1 eb5/1~');
    expect(find(score, 'bar2')).toContain('n1 ~eb5/1');
  });

  it('marks both sides of a note mid-chain', () => {
    const score = aBar([
      makeNote({ id: 'note-1', onset: 0, duration: dur(1), pitch: 'Eb5', tie: 'both' }),
    ]);
    expect(find(score, 'bar1')).toContain('n1 ~eb5/1~');
  });

  it('marks a triplet, and a general tuplet by its ratio', () => {
    const triplet = aBar(
      [
        makeNote({ id: 'note-1', onset: 0, duration: dur(8), pitch: 'C5' }),
        makeNote({ id: 'note-2', onset: 160, duration: dur(8), pitch: 'D5' }),
        makeNote({ id: 'note-3', onset: 320, duration: dur(8), pitch: 'E5' }),
      ],
      { tuplets: [{ id: 'tuplet-1', actual: 3, normal: 2, memberIds: ['note-1', 'note-2', 'note-3'] }] },
    );
    expect(find(triplet, 'bar1')).toContain('n1 c5/8(3)  n2 d5/8(3)  n3 e5/8(3)');

    const quintuplet = aBar(
      [makeNote({ id: 'note-1', onset: 0, duration: dur(16), pitch: 'C5' })],
      { tuplets: [{ id: 'tuplet-1', actual: 5, normal: 4, memberIds: ['note-1'] }] },
    );
    expect(find(quintuplet, 'bar1')).toContain('n1 c5/16(5:4)');
  });

  it('marks a flagged note with !', () => {
    const score = aBar([
      makeNote({ id: 'note-1', onset: 0, duration: dur(2), pitch: 'Gb5' }),
      makeNote({
        id: 'note-2',
        onset: 2 * Q,
        duration: dur(4),
        pitch: 'F5',
        review: { flagged: true, reasons: ['low-confidence'] },
      }),
    ]);
    expect(find(score, 'bar1')).toContain('n2 f5/4 !');
  });

  it('marks a flagged bar on its label', () => {
    const score = aBar([makeNote({ id: 'note-1', onset: 0, duration: dur(4), pitch: 'C5' })], {
      review: { flagged: true, reasons: ['metrically-invalid'] },
    });
    expect(find(score, 'bar1')).toMatch(/^\s*bar1!/);
  });

  it('prints nothing for an empty bar, so a blank chart stays compact', () => {
    // R2 is that an agent can read a chart cheaply. Thirty-two lines of nothing is the opposite.
    const blank = chart(
      Array.from({ length: 32 }, (_, index) => makeBar({ id: `bar-${index + 1}`, number: index + 1 })),
    );
    expect(lines(blank).filter((line) => /^\s+bar\d+!?\s/.test(line))).toHaveLength(0);
    expect(projectScore(blank).length).toBeLessThan(700);
  });
});

describe('the review legend', () => {
  it('explains ! only when something is flagged', () => {
    const clean = chart([
      makeBar({
        id: 'bar-1',
        number: 1,
        items: [makeNote({ id: 'note-1', onset: 0, duration: dur(1), pitch: 'C5' })],
      }),
    ]);
    expect(projectScore(clean)).not.toContain('needs review');

    const flagged = chart([
      makeBar({
        id: 'bar-1',
        number: 1,
        items: [makeNote({ id: 'note-1', onset: 0, duration: dur(4), pitch: 'C5' })],
        review: { flagged: true, reasons: ['metrically-invalid'] },
      }),
    ]);
    expect(projectScore(flagged)).toContain('! = needs review');
  });

  it('counts the bars that do not fill the meter, so a reader knows where to look', () => {
    const score = chart([
      makeBar({
        id: 'bar-1',
        number: 1,
        items: [makeNote({ id: 'note-1', onset: 0, duration: dur(4), pitch: 'C5' })],
        review: { flagged: true, reasons: ['metrically-invalid'] },
      }),
      makeBar({ id: 'bar-2', number: 2, review: { flagged: true, reasons: ['metrically-invalid'] } }),
    ]);
    expect(projectScore(score)).toContain('2 bars do not fill the meter');
  });
});

describe('it prints the addresses the CLI accepts (ADR-0007, ADR-0009)', () => {
  /**
   * The design principle the whole addressing scheme rests on: reading the projection is how an agent
   * learns to write an address, so it never has to guess or construct one. Which means every address
   * printed here has to resolve.
   */
  it('every nK it prints resolves to the very object printed beside it', () => {
    /**
     * Not merely "resolves". The first version of this only asserted the address did not throw, and a
     * mutation that made the projection number *notes* while the resolver numbers *items* sailed
     * straight through it: every address still resolved, just to a different object than the one on
     * the page. Which is the precise failure this test exists to prevent — an agent reading `n2` and
     * editing something else.
     */
    const score = nastyChart();
    let checked = 0;

    for (const line of projectScore(score).split('\n')) {
      const bar = /^\s*bar(\d+)!?\s/.exec(line);
      if (bar === null) continue;

      for (const printed of line.matchAll(/\bn(\d+) (\S+)/g)) {
        const address = `bar${bar[1]}.n${printed[1]}`;
        const target = resolveAddress(score, address).target;
        // Strip the decorations to leave what the object *is*.
        const body = (printed[2] ?? '').replace(/^~/, '').split('/')[0] ?? '';
        const expected = 'kind' in target && target.kind === 'rest' ? 'r' : formatPitch((target as { pitch: Parameters<typeof formatPitch>[0] }).pitch).toLowerCase();
        expect(body, `${address} printed ${printed[2]}`).toBe(expected);
        checked += 1;
      }
    }
    // A test that checked nothing would pass. This chart has plenty, rests among them.
    expect(checked).toBeGreaterThan(50);
  });

  it('and they resolve to the items in the order the line lists them', () => {
    const score = nastyChart();
    for (const bar of score.bars) {
      const line = find(score, `bar${bar.number} `) || find(score, `bar${bar.number}!`);
      if (line === '') continue;
      const ordinals = [...line.matchAll(/\bn(\d+)\b/g)].map((match) => Number(match[1]));
      expect(ordinals).toEqual(ordinals.map((_, index) => index + 1));
    }
  });

  it('prints a legend built from a real object in this score', () => {
    const score = chart([
      makeBar({
        id: 'bar-1',
        number: 1,
        items: [
          makeNote({ id: 'note-1', onset: 0, duration: dur(4), pitch: 'C5' }),
          makeNote({ id: 'note-7', onset: 2 * Q, duration: dur(2), pitch: 'E5' }),
        ],
      }),
    ]);
    const legend = find(score, 'Address:');
    expect(legend).toBe('Address: bar1.n2  or  bar1.beat3  or  note-7');
    // And every form in the legend actually works.
    for (const address of ['bar1.n2', 'bar1.beat3', 'note-7']) {
      expect(resolveAddress(score, address).target.id).toBe('note-7');
    }
  });

  it('says onsets-only in the legend, since that is the rule an agent will trip on', () => {
    expect(projectScore(nastyChart())).toContain('Onsets only');
  });

  it('falls back to a generic legend for a score with nothing in it', () => {
    expect(find(chart([]), 'Address:')).toContain('an id like note-17');
  });
});

describe('it is lossy by design', () => {
  it('drops what only the structured dump carries, and that is the trade', () => {
    // ADR-0009 is explicit that this is lossy and that anything not here must still be reachable
    // through the full dump. Asserting it keeps the claim honest rather than aspirational.
    const score = chart([
      makeBar({
        id: 'bar-1',
        number: 1,
        items: [
          makeNote({
            id: 'note-1',
            onset: 0,
            duration: dur(1),
            pitch: 'Db5',
            accidental: 'show',
            spellingPinned: true,
            confidence: 0.42,
          }),
        ],
        annotations: [makeAnnotation({ id: 'annotation-1', onset: 0, text: 'solo break' })],
        startBarline: 'repeat-start',
        endBarline: 'repeat-end',
        ending: { numbers: [1], role: 'start-stop' },
      }),
    ]);
    const projection = projectScore(score);
    for (const dropped of ['0.42', 'spellingPinned', 'repeat', 'solo break', 'ending']) {
      expect(projection).not.toContain(dropped);
    }
    // The spelling itself is not lost, because that is the note's identity rather than its metadata.
    expect(projection).toContain('db5');
  });

  it('is small enough to reason over, which is the whole requirement (R2)', () => {
    // The nasty chart is 19 bars of deliberately awkward music. A few hundred tokens, not tens of
    // thousands of MusicXML.
    const projection = projectScore(nastyChart());
    expect(projection.length).toBeLessThan(2500);
    expect(JSON.stringify(nastyChart()).length).toBeGreaterThan(projection.length * 8);
  });
});
