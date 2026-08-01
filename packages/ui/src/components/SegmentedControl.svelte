<script lang="ts" generics="T extends string">
  /**
   * A segmented control over a list the renderer published — never a hardcoded pair.
   * `PAPERS` and `FONTS` come from `PAPER_SIZES` and `MUSIC_FONT_NAMES`, so a third face or a
   * third paper appears here as a third segment, the same way the export route's 422 quotes a
   * list it derives rather than one it restates.
   */
  interface Props {
    label: string;
    options: readonly T[];
    value: T;
    display?: (option: T) => string;
    onselect: (option: T) => void;
  }

  const { label, options, value, display, onselect }: Props = $props();
</script>

<div class="seg" role="group" aria-label={label}>
  {#each options as option (option)}
    <button
      aria-pressed={option === value}
      onclick={() => {
        if (option !== value) onselect(option);
      }}
    >
      {display === undefined ? option : display(option)}
    </button>
  {/each}
</div>

<style>
  .seg {
    display: flex;
    border: 1px solid var(--rule);
    background: var(--panel-2);
    width: fit-content;
  }
  .seg button {
    background: none;
    border: 0;
    padding: 5px 13px 6px;
    cursor: pointer;
    font-size: 11.5px;
    letter-spacing: 0.06em;
    color: var(--ink-soft);
  }
  .seg button + button {
    border-left: 1px solid var(--rule);
  }
  .seg button[aria-pressed="true"] {
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 600;
  }
  .seg button:hover:not([aria-pressed="true"]) {
    color: var(--ink);
  }
</style>
