import { readFileSync } from 'node:fs';
import { grandStaffChart, nastyChart } from '@sibei/fixtures';
import { allBarViews } from '@sibei/model';
import { BINDINGS, INPUT_ROWS, SHORTCUT_GROUPS, actionForKey, chartActionFor, edgeItem, neighbourItem } from '@sibei/ui';
import type { ChartAction } from '@sibei/ui';
import { describe, expect, it } from 'vitest';

/**
 * SIB2-268: the keymap is one table. The `?` overlay is printed from it and the score view dispatches through it, so
 * these tests only have to prove the table is complete and honest: every action is in it, every sample key resolves to
 * its own action (and nothing else's), every binding is listed, and every note-input row describes a key the mode takes.
 */

const ACTIONS: ChartAction[] = ['undo', 'redo', 'help', 'select-all', 'deselect', 'delete', 'next', 'prev', 'next-bar', 'prev-bar', 'up', 'down', 'voice', 'note-input'];

describe('the keymap', () => {
  it('has exactly one binding per action', () => {
    expect(BINDINGS.map((binding) => binding.action).sort()).toEqual([...ACTIONS].sort());
  });

  it('resolves every sample key to its own binding, and to no other', () => {
    for (const binding of BINDINGS) {
      expect(binding.samples.length, binding.action).toBeGreaterThan(0);
      for (const sample of binding.samples) {
        expect(chartActionFor(sample, false), `${binding.action} ${sample.key}`).toBe(binding.action);
        expect(BINDINGS.filter((other) => other.match(sample)).map((other) => other.action), `${binding.action} ${sample.key}`).toEqual([binding.action]);
        // Note input claims everything but undo, redo and help.
        expect(chartActionFor(sample, true), `${binding.action} ${sample.key} in note input`).toBe(binding.inNoteInput ? binding.action : null);
      }
    }
  });

  it('prints every binding in the overlay, and every note-input row with a key the mode takes', () => {
    const printed = SHORTCUT_GROUPS.flatMap((group) => group.rows.map(([keys, does]) => `${keys}|${does}`));
    for (const binding of BINDINGS) expect(printed, binding.action).toContain(`${binding.keys}|${binding.does}`);
    for (const row of INPUT_ROWS) {
      expect(printed).toContain(`${row.keys}|${row.does}`);
      for (const sample of row.samples) expect(actionForKey(sample), `${row.keys} ${sample.key}`).not.toBeNull();
    }
  });

  it('is dispatched by the score view for every action, so a row cannot be a promise nothing keeps', () => {
    const source = readFileSync(new URL('../../packages/ui/src/components/ScoreView.svelte', import.meta.url), 'utf8');
    for (const action of ACTIONS) expect(source, action).toContain(`'${action}'`);
  });
});

describe('arrow-key navigation (SIB2-268)', () => {
  const score = nastyChart();
  const lane = { staff: 1, voice: 1 };
  const first = edgeItem(score, lane, 'first')!;

  it('walks the voice in reading order, across barlines, and stops at the ends', () => {
    expect(neighbourItem(score, first, 'prev')).toBeNull();
    const second = neighbourItem(score, first, 'next')!;
    expect(second).not.toBe(first);
    expect(neighbourItem(score, second, 'prev')).toBe(first);
    const last = edgeItem(score, lane, 'last')!;
    expect(neighbourItem(score, last, 'next')).toBeNull();
  });

  it('jumps a bar at a time, to the first item of the bar', () => {
    const bars = allBarViews(score)[0]!.views.filter((view) => view.items.length > 0);
    const target = neighbourItem(score, first, 'next-bar')!;
    const inBar = bars[1]!.items.map((item) => item.id);
    expect(inBar).toContain(target);
    expect(target).toBe([...bars[1]!.items].sort((a, b) => a.onset - b.onset)[0]!.id);
    expect(neighbourItem(score, target, 'prev-bar')).toBe(first);
    expect(neighbourItem(score, first, 'prev-bar')).toBeNull();
  });

  it('crosses between staves of a grand staff, and nowhere on a single one', () => {
    expect(neighbourItem(score, first, 'up')).toBeNull();
    expect(neighbourItem(score, first, 'down')).toBeNull();
    const grand = grandStaffChart();
    const top = edgeItem(grand, { staff: 1, voice: 1 }, 'first')!;
    const below = neighbourItem(grand, top, 'down');
    expect(below).not.toBeNull();
    expect(neighbourItem(grand, below!, 'up')).toBe(top);
    expect(neighbourItem(grand, top, 'up')).toBeNull();
  });

  it('knows no item that is not there', () => {
    expect(neighbourItem(score, 'nope', 'next')).toBeNull();
  });
});
