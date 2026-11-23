<script lang="ts">
  /**
   * The `?` overlay: every keyboard shortcut of the score view in one place. Plain content, no behaviour of its own
   * beyond closing; the keys themselves live with the code that handles them (`ScoreView.svelte`,
   * `../lib/note-input.ts`); `tests/browser/note-input.test.ts` checks the digit rule below.
   */
  interface Props {
    onclose: () => void;
  }
  const { onclose }: Props = $props();

  interface Group {
    title: string;
    note?: string;
    rows: ReadonlyArray<[string, string]>;
  }

  const GROUPS: readonly Group[] = [
    {
      title: 'Anywhere in a chart',
      rows: [
        ['Ctrl/⌘ Z', 'Undo'],
        ['Ctrl/⌘ Shift Z, Ctrl Y', 'Redo'],
        ['N', 'Start note input'],
        ['1 to 4', 'Choose that voice of the active staff (charts with more than one lane)'],
        ['?', 'This list'],
      ],
    },
    {
      title: 'Note input',
      note: 'Inside note input the digits are note values, not voices. Ctrl+Alt+1 to 4 picks the voice instead.',
      rows: [
        ['1 2 3 4 5 6', '32nd, 16th, eighth, quarter, half, whole'],
        ['.', 'Dot the next note'],
        ['A to G', 'Enter that pitch, in the octave nearest the last note, in the key signature'],
        ['Shift + A to G', 'Add that pitch above the last note, making a chord'],
        ['R', 'Rest'],
        ['↑ ↓', 'Move the last note a step; with Ctrl/⌘, an octave'],
        ['+ or #  /  -  /  0', 'Sharpen, flatten or naturalise the last note (with no note before the caret: the next one)'],
        ['T', 'Tie the last note to the next'],
        ['Enter, Space', 'Skip forward over a value; at the end of the chart, add a bar'],
        ['Backspace', 'Delete the previous note and step back'],
        ['← →', 'Move the caret'],
        ['Ctrl+Alt+1 to 4', 'Switch voice'],
        ['Esc', 'Leave note input'],
      ],
    },
  ];

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
