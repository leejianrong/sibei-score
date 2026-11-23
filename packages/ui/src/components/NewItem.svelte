<script lang="ts">
  /**
   * Put a note or a rest at a beat of the selected bar, in the active staff and voice — the browser half of
   * `sbscore note add` / `rest add`, and how a second staff or voice gets its first notes (ADR-0041, slice 5b).
   * It builds nothing itself: `onnew` hands `ScoreView` the item, which becomes the qualified `note.add` / `rest.add`
   * (`s2.v2.bar3.beat1`) so it can never land on the first staff by default. A refused add (the beat is taken, the
   * pitch is not one) comes back through the bar panel's error line.
   */
  import { untrack } from 'svelte';
  import type { NoteValue } from '@sibei/model';
  import type { NewItem } from '../lib/staff-edits.js';
  import SegmentedControl from './SegmentedControl.svelte';

  interface Props {
    barNumber: number;
    /** `Staff 2 · bass · Voice 2`: where the item will go. */
    laneText: string;
    seedPitch: string;
    saving: boolean;
    /** The chart's beat unit (4 in 4/4, 8 in 6/8), so the beat field can advance by what was just entered. */
    beatValue?: number;
    /** Resolves true when the item landed. The bar stays selected then (SIB2-265), so entry can go on. */
    onnew: (item: NewItem) => void | Promise<boolean>;
  }

  const { barNumber, laneText, seedPitch, saving, beatValue = 4, onnew }: Props = $props();

  const VALUES: readonly NoteValue[] = [1, 2, 4, 8, 16, 32];
  const DOTS = [0, 1, 2] as const;

  let beat = $state('1');
  let pitch = $state(untrack(() => seedPitch));
  let value = $state<NoteValue>(4);
  let dots = $state<0 | 1 | 2>(0);

  const beatValid = $derived(Number.isFinite(Number(beat)) && Number(beat) >= 1);

  let pitchField = $state<HTMLInputElement | null>(null);

  /** How many of the chart's beats an item lasts: a quarter is one beat in 4/4, two in 6/8. Dots add half, then a quarter more. */
  function beatsOf(duration: { value: number; dots: number }): number {
    return (beatValue / duration.value) * (2 - 1 / 2 ** duration.dots);
  }

  async function put(kind: 'note' | 'rest'): Promise<void> {
    if (!beatValid) return;
    const duration = { value, dots };
    const landed = await onnew({ kind, beat: Number(beat), pitch: pitch.trim(), duration });
    if (landed === false) return;
    // The next item goes right after this one, and the pitch field keeps the focus, so the next note is typed at once (SIB2-265).
    beat = String(Math.round((Number(beat) + beatsOf(duration)) * 1000) / 1000);
    pitchField?.focus();
  }
</script>

<div class="new-item">
  <span class="label">New item in bar {barNumber} · <b data-testid="new-item-lane">{laneText}</b></span>
  <div class="row">
    <input
      class="field beat"
      inputmode="decimal"
      aria-label="Beat of the new item"
      value={beat}
      oninput={(event) => (beat = (event.currentTarget as HTMLInputElement).value)}
    />
    <input
      class="field"
      aria-label="Name of the new note"
      bind:this={pitchField}
      placeholder="Eb4, F#3…"
      value={pitch}
      oninput={(event) => (pitch = (event.currentTarget as HTMLInputElement).value)}
    />
  </div>
  <SegmentedControl label="Value of the new item" options={VALUES} {value} onselect={(chosen) => (value = chosen)} />
  <SegmentedControl label="Dots of the new item" options={DOTS} value={dots} onselect={(chosen) => (dots = chosen)} />
  <div class="row">
    <button type="button" class="btn" disabled={saving || !beatValid || pitch.trim() === ''} onclick={() => put('note')}>New note</button>
    <button type="button" class="btn" disabled={saving || !beatValid} onclick={() => put('rest')}>New rest</button>
  </div>
  <p class="note">
    Goes to the active staff and voice (change them in the rail, or click another staff). A beat that is taken in that voice is refused.
  </p>
</div>

<style>
  .new-item {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--rule);
  }
  .label {
    font-size: 11px;
    color: var(--ink-faint);
  }
  .label b {
    color: var(--ink-soft);
    font-weight: 600;
  }
  .row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .field {
    font: inherit;
    font-size: 12px;
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    background: var(--panel-2);
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 5px 7px;
  }
  .field.beat {
    flex: 0 0 52px;
  }
  .btn {
    font: inherit;
    font-size: 12px;
    border-radius: 6px;
    padding: 4px 10px;
    cursor: pointer;
    border: 1px solid var(--rule);
    background: transparent;
    color: var(--ink-soft);
  }
  .btn:hover:not(:disabled) {
    color: var(--ink);
    border-color: var(--ink-faint);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .note {
    margin: 0;
    font-size: 11px;
    color: var(--ink-faint);
    line-height: 1.5;
  }
</style>
