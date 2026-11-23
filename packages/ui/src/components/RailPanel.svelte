<script lang="ts">
  /**
   * One collapsible panel of the score view's rail (SIB2-264). A native `<details>`, so it is keyboard
   * operable and announced as a disclosure with no script; the heading stays an `<h3>` inside the summary so
   * the panel names are the same words they were. Open state is remembered per title (`lib/rail-panels.ts`).
   */
  import type { Snippet } from 'svelte';
  import { panelOpen, rememberPanel } from '../lib/rail-panels.js';

  interface Props {
    title: string;
    /** Open the first time, before anything is remembered. */
    open?: boolean;
    /** Flow the body as plain blocks instead of a column of controls. */
    plain?: boolean;
    children: Snippet;
  }

  const { title, open = false, plain = false, children }: Props = $props();

  // svelte-ignore state_referenced_locally
  let isOpen = $state(panelOpen(title, open));
</script>

<details
  class="rail-panel"
  data-panel={title}
  bind:open={isOpen}
  ontoggle={(event) => rememberPanel(title, event.currentTarget.open)}
>
  <summary><h3>{title}</h3></summary>
  <div class="body" class:controls={!plain}>{@render children()}</div>
</details>

<style>
  .rail-panel {
    border-top: 1px solid var(--rule);
  }
  summary {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 6px 0;
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary::before {
    content: '';
    width: 6px;
    height: 6px;
    flex: none;
    border-right: 1.5px solid var(--ink-faint);
    border-bottom: 1.5px solid var(--ink-faint);
    transform: rotate(-45deg);
    transition: transform 120ms ease;
  }
  details[open] > summary::before {
    transform: rotate(45deg);
  }
  summary:hover h3 {
    color: var(--accent);
  }
  summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  h3 {
    font-size: 10.5px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--ink-faint);
    margin: 0;
    font-weight: 600;
  }
  .body {
    padding: 4px 0 14px;
  }
  .body.controls {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  @media (prefers-reduced-motion: reduce) {
    summary::before {
      transition: none;
    }
  }
</style>
