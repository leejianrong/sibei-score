<script lang="ts">
  /**
   * The instrument list of the New chart form (SIB2-272, SIB2-288): the browser half of
   * `sbscore new --instrument piano --instrument bass`. Rows run top to bottom, which is the order of the staves on the
   * page; each row picks a preset, moves up or down, or goes. An empty list is the plain lead sheet, so the form's
   * old behaviour is what you get until you ask for more. Which presets exist is the model's catalogue, the same one
   * the server resolves the ids against.
   */
  import { INSTRUMENT_CHOICES, instrumentList } from '../lib/new-chart.js';
  import { MAX_SETUP_INSTRUMENTS } from '@sibei/model';

  interface Props {
    value: readonly string[];
    onchange: (next: string[]) => void;
    disabled?: boolean;
  }

  const { value, onchange, disabled = false }: Props = $props();
</script>

<fieldset class="picker" aria-label="Instruments" {disabled}>
  <legend>Instruments</legend>
  {#if value.length === 0}
    <p class="hint">A lead sheet: one treble staff with chords. Pick instruments for a piano, a band or a horn part.</p>
  {/if}
  <ol class="rows">
    {#each value as id, at (at)}
      <li class="row">
        <select
          aria-label={`Instrument preset ${at + 1}`}
          value={id}
          onchange={(event) => onchange(instrumentList.change(value, at, (event.currentTarget as HTMLSelectElement).value))}
        >
          {#each INSTRUMENT_CHOICES as choice (choice.id)}
            <option value={choice.id}>{choice.label}</option>
          {/each}
        </select>
        <button type="button" class="icon" aria-label={`Move row ${at + 1} up`} disabled={at === 0} onclick={() => onchange(instrumentList.move(value, at, -1))}>↑</button>
        <button type="button" class="icon" aria-label={`Move row ${at + 1} down`} disabled={at === value.length - 1} onclick={() => onchange(instrumentList.move(value, at, 1))}>↓</button>
        <button type="button" class="icon" aria-label={`Remove row ${at + 1}`} onclick={() => onchange(instrumentList.remove(value, at))}>✕</button>
      </li>
    {/each}
  </ol>
  <button type="button" class="another" disabled={value.length >= MAX_SETUP_INSTRUMENTS} onclick={() => onchange(instrumentList.add(value))}>
    {value.length === 0 ? 'Choose instruments' : 'Another instrument'}
  </button>
</fieldset>

<style>
  .picker {
    flex-basis: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    border: 0;
    min-inline-size: 0;
  }
  legend {
    padding: 0;
    margin-bottom: 4px;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-soft);
  }
  .hint {
    margin: 0;
    font-size: 13px;
    color: var(--ink-soft);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  select {
    flex: 1 1 200px;
    max-width: 280px;
    font: inherit;
    font-size: 13px;
    color: var(--ink);
    background: var(--panel);
    border: 1px solid var(--rule);
    border-radius: 3px;
    padding: 6px 8px;
    min-height: 36px;
  }
  button {
    font: inherit;
    font-size: 13px;
    color: var(--ink);
    background: var(--panel);
    border: 1px solid var(--rule);
    border-radius: 3px;
    cursor: pointer;
    min-height: 36px;
  }
  .icon {
    min-width: 36px;
  }
  .another {
    align-self: flex-start;
    padding: 6px 12px;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
