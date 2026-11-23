<script lang="ts">
  /**
   * What to do with several selected notes and rests at once (SIB2-278). Each button hands `ScoreView` one
   * `SelectionEdit`, which `selectionOps` turns into ordinary ops sent as **one batch**, so a single ctrl-Z reverses
   * the whole edit. Nothing here writes anything itself.
   */
  import type { Articulation, Dots, NoteValue } from '@sibei/model';
  import type { SelectionEdit } from '../lib/selection.js';
  import SegmentedControl from './SegmentedControl.svelte';

  interface Props {
    count: number;
    notes: number;
    /** The staves a selection can be moved to, `s2` and a label. */
    staves: readonly { value: string; label: string }[];
    saving: boolean;
    error: string | null;
    onedit: (edit: SelectionEdit) => void;
    onclear: () => void;
  }

  const { count, notes, staves, saving, error, onedit, onclear }: Props = $props();

  const VALUES: readonly NoteValue[] = [1, 2, 4, 8, 16, 32];
  const DOTS = [0, 1, 2] as const;
  const MARKS: readonly { label: string; marks: Articulation[] }[] = [
    { label: 'Staccato', marks: ['staccato'] },
    { label: 'Accent', marks: ['accent'] },
    { label: 'Marcato', marks: ['marcato'] },
    { label: 'No marks', marks: [] },
  ];

  let value = $state<NoteValue>(4);
  let dots = $state<Dots>(0);
  let target = $state('');
  const moveTo = $derived(target !== '' ? target : (staves[0]?.value ?? ''));
</script>

<div class="selection-panel" role="group" aria-label="Selection" data-testid="selection-panel">
  <p class="count" data-testid="selection-count">{count} items selected{notes < count ? ` (${notes} notes)` : ''}</p>
  <div class="row">
    <button type="button" class="btn" disabled={saving} onclick={() => onedit({ type: 'step', steps: 1 })}>Up a step</button>
    <button type="button" class="btn" disabled={saving} onclick={() => onedit({ type: 'step', steps: -1 })}>Down a step</button>
    <button type="button" class="btn" disabled={saving} onclick={() => onedit({ type: 'step', steps: 7 })}>Up an octave</button>
    <button type="button" class="btn" disabled={saving} onclick={() => onedit({ type: 'step', steps: -7 })}>Down an octave</button>
  </div>
  <SegmentedControl label="Value for the selection" options={VALUES} {value} onselect={(chosen) => (value = chosen)} />
  <SegmentedControl label="Dots for the selection" options={DOTS} value={dots} onselect={(chosen) => (dots = chosen)} />
  <div class="row">
    <button type="button" class="btn" disabled={saving} onclick={() => onedit({ type: 'duration', duration: { value, dots } })}>Set duration</button>
    <button type="button" class="btn" disabled={saving || notes < 2} onclick={() => onedit({ type: 'tie', on: true })}>Tie together</button>
    <button type="button" class="btn" disabled={saving || notes === 0} onclick={() => onedit({ type: 'tie', on: false })}>Untie</button>
  </div>
  <div class="row">
    {#each MARKS as mark (mark.label)}
      <button type="button" class="btn" disabled={saving || notes === 0} onclick={() => onedit({ type: 'articulation', marks: mark.marks })}>{mark.label}</button>
    {/each}
  </div>
  {#if staves.length > 1}
    <div class="row">
      <select class="field" aria-label="Staff to move the selection to" value={moveTo} onchange={(event) => (target = (event.currentTarget as HTMLSelectElement).value)}>
        {#each staves as staff (staff.value)}
          <option value={staff.value}>{staff.label}</option>
        {/each}
      </select>
      <button type="button" class="btn" disabled={saving || notes === 0} onclick={() => onedit({ type: 'move', to: moveTo })}>Move to staff</button>
    </div>
  {/if}
  <div class="row">
    <button type="button" class="btn danger" disabled={saving} onclick={() => onedit({ type: 'delete' })}>Delete selection</button>
    <button type="button" class="btn" onclick={onclear}>Clear selection</button>
  </div>
  {#if error !== null}<p class="problem" role="alert">{error}</p>{/if}
  <p class="note">
    Shift-click a second note to select the range, Ctrl/⌘-click to add or remove one, shift-click another bar to select
    a bar range, Ctrl/⌘ A for the whole staff. One undo reverses an edit to all of it.
  </p>
</div>

<style>
  .selection-panel {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
  }
  .selection-panel > .note,
  .selection-panel > .problem {
    flex-basis: 100%;
  }
  .count {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .btn,
  .field {
    font: inherit;
    font-size: 12px;
    border-radius: 6px;
    padding: 4px 10px;
    border: 1px solid var(--rule);
    background: transparent;
    color: var(--ink-soft);
  }
  .btn {
    cursor: pointer;
  }
  .btn:hover:not(:disabled) {
    color: var(--ink);
    border-color: var(--ink-faint);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .btn.danger:hover:not(:disabled) {
    color: var(--flag);
    border-color: var(--flag);
  }
  .field {
    flex: 1;
    min-width: 0;
    background: var(--panel-2);
  }
  .note {
    margin: 0;
    font-size: 11px;
    color: var(--ink-faint);
    line-height: 1.5;
  }
  .problem {
    margin: 0;
    font-size: 11px;
    color: var(--flag);
  }
</style>
