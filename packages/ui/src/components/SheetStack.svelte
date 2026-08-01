<script lang="ts">
  /**
   * The pages, as pages.
   *
   * **A vertical stack of discrete whole sheets**, each keeping its full bottom whitespace, a
   * page number in the left gutter once there is more than one page, and a dashed rule between
   * them labelled "page turn". Not a pager, and the bottom of a sheet is never cropped: that
   * white is where the chart *stops* on the printed page, and trimming it would make the screen
   * disagree with the paper about the one thing ADR-0015 says they must agree on.
   *
   * The markup goes in with `{@html}` because the engraver emits **markup**, not DOM nodes
   * (ADR-0030) — the same string the server hands to pdfkit, byte for byte, and there is a test
   * that says so.
   */
  import type { RenderedPage } from '../lib/render.js';

  interface Props {
    pages: readonly RenderedPage[];
  }

  const { pages }: Props = $props();
  const multi = $derived(pages.length > 1);
</script>

<div class="sheets">
  {#each pages as page, index (page.index)}
    {#if index > 0}
      <div class="turn">page turn</div>
    {/if}
    <div class="sheet-block">
      <div class="sheet-wrap">
        {#if multi}
          <div class="gutter">
            <span class="n">{index + 1}</span><span class="of">of {pages.length}</span>
          </div>
        {/if}
        <div class="sheet">{@html page.svg}</div>
      </div>
    </div>
  {/each}
</div>

<style>
  .sheets {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  /* one page = one discrete sheet, whole, including the white at the bottom.
     That white is information: it is where the chart stops on the printed page. */
  .sheet-block {
    width: 100%;
    display: flex;
    justify-content: center;
  }

  .sheet-wrap {
    position: relative;
    width: var(--sheet-w);
    padding-left: 44px;
  }

  .sheet {
    background: var(--paper);
    box-shadow: var(--sheet-shadow);
    outline: 1px solid var(--sheet-edge);
    outline-offset: -1px;
  }
  .sheet :global(svg) {
    display: block;
    width: 100%;
    height: auto;
  }

  .gutter {
    position: absolute;
    left: 0;
    top: 0;
    width: 44px;
    padding-right: 15px;
    text-align: right;
    font-size: 11px;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.05em;
  }
  .gutter .n {
    display: block;
    padding-top: 2px;
  }
  .gutter .of {
    display: block;
    font-size: 9.5px;
    color: var(--ink-faint);
    opacity: 0.7;
  }

  /* between two sheets: this is a page turn on a music stand, so it gets named */
  .turn {
    width: var(--sheet-w);
    margin: 0 auto;
    padding: 22px 0 22px 44px;
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--ink-faint);
    font-size: 10px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
  .turn::before,
  .turn::after {
    content: "";
    flex: 1;
    border-top: 1px dashed var(--rule);
  }

  @media (max-width: 900px) {
    .sheet-wrap,
    .turn {
      padding-left: 0;
      width: 100%;
    }
    .gutter {
      position: static;
      width: auto;
      text-align: left;
      padding: 0 0 7px;
    }
    .gutter .n,
    .gutter .of {
      display: inline;
    }
  }
</style>
