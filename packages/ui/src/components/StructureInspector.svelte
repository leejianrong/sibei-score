<script lang="ts" module>
  import type { EndBarline, EndingRole, StartBarline } from '@sibei/model';
  import type { BarStructure, StructureEdits } from '../lib/structure-edits.js';

  /** The model's ending roles, worn as words a reader recognises (the approved V7c labels). */
  const ROLE_OPTIONS: { value: 'none' | EndingRole; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'start-stop', label: '1 bar' },
    { value: 'start', label: 'Start' },
    { value: 'continue', label: 'Mid' },
    { value: 'stop', label: 'End' },
  ];

  const START_OPTIONS: { value: StartBarline; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'repeat-start', label: 'Repeat' },
  ];

  const END_OPTIONS: { value: EndBarline; label: string }[] = [
    { value: 'single', label: 'Single' },
    { value: 'double', label: 'Double' },
    { value: 'final', label: 'Final' },
    { value: 'repeat-end', label: 'Repeat' },
  ];
</script>

<script lang="ts">
  /**
   * The Structure panel — V7c. Selecting a bar (or its barline) on the sheet opens this, the
   * browser control for the section, barline and ending verbs V7a/V7b built for the CLI. It closes
   * the Q79 parity those slices booked as debt.
   *
   * Like the note `Inspector`, it never decides the version or owns conflict recovery: Save calls
   * `onsave` with the bar's desired structure, and `ScoreView` turns the diff into the ops —
   * `section.set`/`section.rm`, `barline.set`, `ending.set`/`ending.rm` — and posts them as one
   * batch (one undoable unit). Mounted keyed on the bar number, so the seeds below never have to
   * notice a *different* bar arriving in place — only edits to this one.
   */
  import { untrack } from 'svelte';
  import SegmentedControl from './SegmentedControl.svelte';

  interface Props {
    bar: BarStructure;
    conflict: boolean;
    saving: boolean;
    error: string | null;
    onsave: (edits: StructureEdits) => void;
    ondeselect: () => void;
    onreload: () => void;
  }

  const { bar, conflict, saving, error, onsave, ondeselect, onreload }: Props = $props();

  let letter = $state(untrack(() => bar.letter));
  let name = $state(untrack(() => bar.name));
  let start = $state(untrack(() => bar.startBarline));
  let end = $state(untrack(() => bar.endBarline));
  let role = $state<'none' | EndingRole>(untrack(() => bar.ending?.role ?? 'none'));
  let numbersInput = $state(untrack(() => (bar.ending === null ? '1' : bar.ending.numbers.join(', '))));
  let numbersError = $state<string | null>(null);

  const startDisplay = (o: StartBarline): string => START_OPTIONS.find((x) => x.value === o)?.label ?? String(o);
  const endDisplay = (o: EndBarline): string => END_OPTIONS.find((x) => x.value === o)?.label ?? String(o);
  const roleDisplay = (o: 'none' | EndingRole): string => ROLE_OPTIONS.find((x) => x.value === o)?.label ?? String(o);

  /** `1` or `1, 2` → `[1]` / `[1, 2]`; the server normalises order and duplicates. */
  function parseNumbers(raw: string): number[] | null {
    const parts = raw.split(',').map((piece) => Number(piece.trim()));
    if (parts.length === 0 || parts.some((n) => !Number.isInteger(n) || n < 1)) return null;
    return parts;
  }

  function save(): void {
    let ending: StructureEdits['ending'] = null;
    if (role !== 'none') {
      const numbers = parseNumbers(numbersInput);
      if (numbers === null) {
        numbersError = 'Pass numbers like 1 or 1, 2';
        return;
      }
      ending = { numbers, role };
    }
    numbersError = null;
    onsave({ letter: letter.trim(), name: name.trim(), startBarline: start, endBarline: end, ending });
  }
</script>

<div class="structure">
  <div class="s-head">
    <span class="s-kind"><b>Bar {bar.barNumber}</b>{bar.isPickup ? ' · pickup' : ''}</span>
    <span class="s-addr">{bar.addr}</span>
  </div>

  {#if conflict}
    <div class="conflict">
      <span class="headline">This chart changed elsewhere.</span>
      <span class="body">
        Someone — or another tab — saved a newer version while this was open. Your edit here was
        never sent. Reload to see the current chart, then try it again.
      </span>
      <button type="button" class="btn-reload" onclick={onreload}>Reload chart</button>
    </div>
  {:else}
    <div class="field">
      <span class="field-label">Rehearsal letter · name</span>
      <div class="field-row">
        <input
          class="txt letter"
          aria-label="Rehearsal letter"
          placeholder="—"
          value={letter}
          oninput={(event) => (letter = (event.currentTarget as HTMLInputElement).value)}
        />
        <input
          class="txt grow"
          aria-label="Section name"
          placeholder="Section name (optional)"
          value={name}
          oninput={(event) => (name = (event.currentTarget as HTMLInputElement).value)}
        />
      </div>
      {#if bar.isPickup}
        <p class="note">The pickup sits outside the four-bar grid, so a section here prints a mark but breaks no line.</p>
      {:else if bar.letter === '' && bar.name === ''}
        <p class="note">Type a letter to begin a section here — it forces a line break and prints as a rehearsal mark. Clear both to remove it.</p>
      {/if}
    </div>

    <div class="field">
      <span class="field-label">Opening barline</span>
      <SegmentedControl
        label="Opening barline"
        options={START_OPTIONS.map((o) => o.value)}
        value={start}
        display={startDisplay}
        fill
        onselect={(chosen) => (start = chosen)}
      />
    </div>

    <div class="field">
      <span class="field-label">Closing barline</span>
      <SegmentedControl
        label="Closing barline"
        options={END_OPTIONS.map((o) => o.value)}
        value={end}
        display={endDisplay}
        fill
        onselect={(chosen) => (end = chosen)}
      />
      {#if end === 'repeat-end'}
        <p class="note">A <b>Repeat</b> close pairs with a <b>Repeat</b> open earlier — set both to bracket a repeated span.</p>
      {/if}
    </div>

    <div class="field">
      <span class="field-label">Ending bracket</span>
      <SegmentedControl
        label="Ending role"
        options={ROLE_OPTIONS.map((o) => o.value)}
        value={role}
        display={roleDisplay}
        fill
        onselect={(chosen) => (role = chosen)}
      />
      {#if role !== 'none'}
        <div class="field-row ending-numbers">
          <span class="mini-label">Pass</span>
          <input
            class="txt grow"
            aria-label="Ending pass numbers"
            value={numbersInput}
            oninput={(event) => (numbersInput = (event.currentTarget as HTMLInputElement).value)}
          />
        </div>
        {#if numbersError !== null}
          <p class="field-error">{numbersError}</p>
        {/if}
        <p class="note">
          <b>1 bar</b> opens and closes on this bar; <b>Start</b> / <b>Mid</b> / <b>End</b> span
          several. Numbers <code>1</code> or <code>1, 2</code>.
        </p>
      {/if}
    </div>

    {#if error !== null}
      <p class="field-error">{error}</p>
    {/if}

    <div class="actions">
      <button type="button" class="btn btn-save" disabled={saving} onclick={save}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button type="button" class="btn btn-cancel" disabled={saving} onclick={ondeselect}>
        Deselect
      </button>
    </div>
  {/if}
</div>

<style>
  .structure {
    display: flex;
    flex-direction: column;
    gap: 13px;
  }

  .s-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .s-kind {
    font-size: 12.5px;
    color: var(--ink);
  }
  .s-kind b {
    font-weight: 600;
  }
  .s-addr {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-faint);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .field-label {
    font-size: 11px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--ink-faint);
    font-weight: 600;
  }
  .field-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .field-row .grow {
    flex: 1;
  }
  .ending-numbers .mini-label {
    font-size: 11px;
    color: var(--ink-faint);
  }

  .txt {
    font: inherit;
    font-size: 13px;
    color: var(--ink);
    background: var(--paper);
    border: 1px solid var(--rule);
    border-radius: 6px;
    padding: 6px 8px;
    width: 100%;
  }
  .txt:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
    border-color: var(--accent);
  }
  .txt.letter {
    max-width: 62px;
    text-align: center;
    font-weight: 600;
  }

  .note {
    margin: 2px 0 0;
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--ink-faint);
  }
  .note b {
    color: var(--ink-soft);
    font-weight: 600;
  }
  .note code {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--accent);
  }

  .field-error {
    margin: 0;
    font-size: 11.5px;
    color: var(--flag);
  }

  .actions {
    display: flex;
    gap: 8px;
    margin-top: 2px;
  }
  .btn {
    font: inherit;
    font-size: 12.5px;
    border-radius: 6px;
    padding: 6px 12px;
    cursor: pointer;
    border: 1px solid var(--rule);
  }
  .btn-save {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
    font-weight: 600;
  }
  .btn-save:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .btn-cancel {
    background: transparent;
    color: var(--ink-soft);
  }
  .btn-cancel:hover {
    color: var(--ink);
    border-color: var(--ink-faint);
  }

  .conflict {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 11px;
    border: 1px solid var(--flag);
    border-radius: 7px;
    background: var(--flag-wash);
  }
  .conflict .headline {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink);
  }
  .conflict .body {
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--ink-soft);
  }
  .btn-reload {
    align-self: flex-start;
    font: inherit;
    font-size: 12px;
    border-radius: 6px;
    padding: 5px 11px;
    cursor: pointer;
    border: 1px solid var(--flag);
    background: transparent;
    color: var(--flag);
  }
</style>
