<script lang="ts">
  /**
   * The `?` overlay: every keyboard shortcut of the score view in one place. No behaviour of its own beyond closing,
   * and no list of its own either: the rows are generated from `../lib/keymap.ts`, the same table `ScoreView.svelte`
   * dispatches keys through, so a binding cannot exist without being listed here (`tests/unit/ui-keymap.test.ts`).
   */
  import { SHORTCUT_GROUPS } from '../lib/keymap.js';

  interface Props {
    onclose: () => void;
  }
  const { onclose }: Props = $props();

  const GROUPS = SHORTCUT_GROUPS;

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' || event.key === '?') {
      event.preventDefault();
      event.stopPropagation();
      onclose();
    }
  }
</script>

<svelte:window onkeydowncapture={keydown} />

<div class="scrim" role="presentation" onclick={onclose}></div>
<div class="dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" data-testid="shortcuts">
  <div class="top">
    <h2>Keyboard shortcuts</h2>
    <button type="button" class="close" aria-label="Close shortcuts" onclick={onclose}>Close</button>
  </div>
  {#each GROUPS as group (group.title)}
    <h3>{group.title}</h3>
    {#if group.note !== undefined}<p class="note">{group.note}</p>{/if}
    <dl>
      {#each group.rows as [keys, what] (keys)}
        <dt><kbd>{keys}</kbd></dt>
        <dd>{what}</dd>
      {/each}
    </dl>
  {/each}
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 40;
  }
  .dialog {
    position: fixed;
    z-index: 41;
    top: 10vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(560px, calc(100vw - 32px));
    max-height: 80vh;
    overflow-y: auto;
    box-sizing: border-box;
    padding: 18px 22px 22px;
    background: var(--panel);
    color: var(--ink);
    border: 1px solid var(--rule);
    border-radius: 10px;
    box-shadow: var(--sheet-shadow);
  }
  .top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-size: 15px;
  }
  h3 {
    margin: 16px 0 6px;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .note {
    margin: 0 0 8px;
    font-size: 12px;
    color: var(--ink-soft);
    line-height: 1.5;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 6px 16px;
    margin: 0;
    font-size: 12px;
  }
  dt,
  dd {
    margin: 0;
  }
  dd {
    color: var(--ink-soft);
  }
  kbd {
    font: inherit;
    font-size: 11px;
    border: 1px solid var(--rule);
    border-radius: 3px;
    padding: 0 5px;
    background: var(--panel-2);
  }
  .close {
    font: inherit;
    font-size: 12px;
    border-radius: 6px;
    padding: 3px 10px;
    border: 1px solid var(--rule);
    background: transparent;
    color: var(--ink-soft);
    cursor: pointer;
  }
</style>
