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
   *
   * **Hit-testing (V4c) reads the click, not the markup.** A click on `.sheet` is converted from
   * screen pixels into that page's own `viewBox` units — plain arithmetic against
   * `getBoundingClientRect()`, never `getBBox` or `measureText` (ADR-0015) — and handed to the
   * caller, which owns every musical decision about what the point landed on. This component
   * never looks inside `page.svg` to answer that.
   *
   * The selection box is drawn as a sibling overlay, positioned in percentage space over the
   * same sheet, so it can never edit — and can never desync from — the engraver's own markup.
   */
  import type { RenderedPage } from '../lib/render.js';

  export interface Point {
    x: number;
    y: number;
  }

  /** Just the rectangle an overlay needs — a note box, a chord box and a beat slot all satisfy it. */
  interface OverlayBox {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  interface Props {
    pages: readonly RenderedPage[];
    /** Which item is selected, and its box in that page's layout units. */
    selection?: { pageIndex: number; box: OverlayBox } | null;
    /** Which chord is selected (V5e) — drawn the same way, since only one thing is selected at once. */
    chordSelection?: { pageIndex: number; box: OverlayBox } | null;
    /** Which bar is selected (V7c) — a bracket over the whole bar rather than a tight box on one glyph. */
    barSelection?: { pageIndex: number; box: OverlayBox } | null;
    /** The empty beat under the pointer, where a click would add a chord (V5e). */
    addHint?: { pageIndex: number; box: OverlayBox } | null;
    /** A click on a sheet, translated into that page's own layout units. */
    onselect?: (pageIndex: number, point: Point) => void;
    /** The pointer moving over (or leaving, with `null`) a sheet, in that page's layout units. */
    onhover?: (pageIndex: number, point: Point | null) => void;
  }

  const { pages, selection = null, chordSelection = null, barSelection = null, addHint = null, onselect, onhover }: Props = $props();
  const multi = $derived(pages.length > 1);

  function pointOf(index: number, event: MouseEvent): Point | null {
    const page = pages[index];
    if (page === undefined) return null;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * page.layout.width,
      y: ((event.clientY - rect.top) / rect.height) * page.layout.height,
    };
  }

  function handleClick(index: number, event: MouseEvent): void {
    if (onselect === undefined) return;
    const point = pointOf(index, event);
    if (point !== null) onselect(index, point);
  }

  function handleMove(index: number, event: MouseEvent): void {
    if (onhover === undefined) return;
    onhover(index, pointOf(index, event));
  }

  /** An overlay box positioned in percentage space over the sheet, so it tracks zoom for free. */
  function boxStyle(box: OverlayBox, page: RenderedPage): string {
    return (
      `left: ${(box.x / page.layout.width) * 100}%;` +
      `top: ${(box.y / page.layout.height) * 100}%;` +
      `width: ${(box.width / page.layout.width) * 100}%;` +
      `height: ${(box.height / page.layout.height) * 100}%;`
    );
  }
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
        <!-- A spatial hit-test over engraved positions, not a control with a keyboard
             equivalent — there is nothing at a fixed tab-stop to select this way. Selecting a
             note by keyboard is a later card's scope, not this one's. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="sheet"
          aria-label="Sheet music, page {index + 1}"
          onclick={(event) => handleClick(index, event)}
          onmousemove={(event) => handleMove(index, event)}
          onmouseleave={() => onhover?.(index, null)}
        >
          {@html page.svg}
          {#if barSelection !== null && barSelection.pageIndex === index}
            <div class="hit barsel" style={boxStyle(barSelection.box, page)}></div>
          {/if}
          {#if selection !== null && selection.pageIndex === index}
            <div class="hit selected" style={boxStyle(selection.box, page)}></div>
          {/if}
          {#if chordSelection !== null && chordSelection.pageIndex === index}
            <div class="hit selected" style={boxStyle(chordSelection.box, page)}></div>
          {/if}
          <!-- The add-a-chord marker: a faint dashed target with a plus, shown only where a click
               would land a new chord — never over one that is already there. -->
          {#if addHint !== null && addHint.pageIndex === index && (chordSelection === null || chordSelection.pageIndex !== index)}
            <div class="hit addhint" style={boxStyle(addHint.box, page)}><span>＋</span></div>
          {/if}
        </div>
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
    position: relative;
    background: var(--paper);
    box-shadow: var(--sheet-shadow);
    outline: 1px solid var(--sheet-edge);
    outline-offset: -1px;
    cursor: pointer;
  }
  .sheet :global(svg) {
    display: block;
    width: 100%;
    height: auto;
    pointer-events: none;
  }

  /* Positioned in percentage space over the sheet, so it tracks zoom without its own math and
     can never touch the engraver's own markup underneath it. */
  .hit {
    position: absolute;
    pointer-events: none;
    border-radius: 2px;
  }
  .hit.selected {
    background: var(--accent-wash);
    outline: 1.5px solid var(--accent);
    outline-offset: -1.5px;
  }
  /* A selected bar is a region, not a glyph: a lighter wash and a full outline so it reads as
     "this whole bar" without burying the ink it sits over. */
  .hit.barsel {
    background: var(--accent-wash);
    outline: 1.5px solid var(--accent);
    outline-offset: 0;
  }
  /* The add-a-chord affordance: a dashed target with a centred plus, keyed to the pointer. */
  .hit.addhint {
    border: 1px dashed var(--accent);
    border-radius: 2px;
    background: var(--accent-wash);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .hit.addhint span {
    color: var(--accent);
    font-size: 12px;
    line-height: 1;
    opacity: 0.9;
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
