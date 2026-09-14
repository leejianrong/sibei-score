<script lang="ts">
  /**
   * The retained source scan, beside the recognised score (V14b, ADR-0019).
   *
   * Every parse is a draft, and correcting it is the primary import experience — so the photo that
   * produced a chart is kept forever and shown next to the engraved result, "scrollable and zoomable"
   * (ADR-0019). This is the *scrollable and zoomable* half: a vertical stack of the import's pages in
   * order (Q26), each an `<img>` fetched from the V14a image route (`sourceImageUrl`), with its own
   * zoom independent of the sheet's — the two panes are read against each other, so neither drives the
   * other's magnification.
   *
   * It is only ever an `<img>`. There is no engraving here and nothing to hit-test: the scan is the
   * ground truth a human checks the *rendered score* against, and the rendered score (the editable
   * half) stays the `SheetStack` next door. So this component holds no `layout`/`engrave` and touches
   * none of the geometry rules that govern the sheet — it is a picture viewer.
   */
  import { sourceImageUrl } from '../lib/api.js';

  interface Props {
    /** The import job that produced the open score — its `imageKeys` are the pages, in order. */
    jobId: string;
    /** How many pages the import retained; `GET …/images/:index` serves index 0..imageCount-1. */
    imageCount: number;
  }

  const { jobId, imageCount }: Props = $props();

  // The scan's own zoom, the same 60–200% range in steps of 20 the sheet uses — a document viewer's
  // range, not a design tool's — but a separate piece of state, because the point of two panes is to
  // magnify one without the other (ADR-0019: both zoomable).
  const ZOOM_MIN = 60;
  const ZOOM_MAX = 200;
  const ZOOM_STEP = 20;
  let zoom = $state(100);

  function stepZoom(by: number): void {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom + by));
  }

  const pages = $derived(Array.from({ length: imageCount }, (_, index) => index));

  // A page whose image failed to load (the server 404'd it, or the bytes are unreadable). Tracked so
  // a broken scan shows a quiet placeholder rather than the browser's default broken-image glyph —
  // the review view must never look like the app itself failed. A plain object, reassigned to nudge
  // Svelte's reactivity (a Set mutated in place would not).
  let failed = $state<Record<number, boolean>>({});

  function onImageError(index: number): void {
    failed = { ...failed, [index]: true };
  }
</script>

<section class="source-pane" aria-label="Source scan">
  <div class="src-bar">
    <span class="src-label">
      Source scan · {imageCount} {imageCount === 1 ? 'page' : 'pages'}
    </span>
    <div class="zoom" role="group" aria-label="Zoom the source scan">
      <button aria-label="Zoom out" disabled={zoom <= ZOOM_MIN} onclick={() => stepZoom(-ZOOM_STEP)}>−</button>
      <span class="val">{zoom}%</span>
      <button aria-label="Zoom in" disabled={zoom >= ZOOM_MAX} onclick={() => stepZoom(ZOOM_STEP)}>+</button>
    </div>
  </div>

  <div class="src-scroll">
    <div class="src-inner" style="width: {zoom}%">
      {#each pages as index (index)}
        {#if index > 0}
          <div class="turn">page {index + 1}</div>
        {/if}
        {#if imageCount > 1}
          <div class="page-n">{index + 1} <span class="of">of {imageCount}</span></div>
        {/if}
        {#if failed[index]}
          <div class="scan-broken">
            This page of the scan could not be loaded.
          </div>
        {:else}
          <img
            class="scan"
            src={sourceImageUrl(jobId, index)}
            alt="Source scan, page {index + 1}"
            loading="lazy"
            draggable="false"
            onerror={() => onImageError(index)}
          />
        {/if}
      {/each}
    </div>
  </div>
</section>

<style>
  /* A flex column: a fixed bar on top, a scrolling picture area filling the rest. The outer height
     is set by the parent (the split column), so `min-height: 0` lets the scroll area actually scroll
     rather than growing the pane. */
  .source-pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--panel);
  }

  .src-bar {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 12px 18px;
    border-bottom: 1px solid var(--rule);
    font-size: 11px;
    color: var(--ink-faint);
    letter-spacing: 0.05em;
  }
  .src-label {
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-weight: 600;
  }

  /* Its own zoom control, styled like the stage's so the two panes read as siblings. */
  .zoom {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .zoom button {
    background: none;
    border: 1px solid var(--rule);
    width: 26px;
    height: 24px;
    cursor: pointer;
    color: var(--ink-soft);
    line-height: 1;
  }
  .zoom button:hover:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent);
  }
  .zoom button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .zoom .val {
    min-width: 46px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    color: var(--ink-soft);
  }

  /* Scrolls both ways: vertically through the pages, and horizontally once zoomed past the pane. */
  .src-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 24px 22px 80px;
  }

  /* The zoomed width lives here: at 100% the inner box fits the scroll area; past it, the box grows
     wider than the pane and the scroll area carries it sideways. The images fill this box. */
  .src-inner {
    margin-inline: auto;
  }

  .scan {
    display: block;
    width: 100%;
    height: auto;
    background: var(--paper);
    box-shadow: var(--sheet-shadow);
    outline: 1px solid var(--sheet-edge);
    outline-offset: -1px;
    user-select: none;
  }

  .page-n {
    font-size: 11px;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.05em;
    margin: 0 0 6px;
  }
  .page-n .of {
    font-size: 9.5px;
    opacity: 0.7;
  }

  /* Between two scanned pages, the same named divider the sheet stack draws between printed pages. */
  .turn {
    padding: 20px 0;
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

  .scan-broken {
    padding: 24px;
    border: 1px dashed var(--rule);
    color: var(--ink-faint);
    font-size: 12px;
    text-align: center;
    background: var(--panel-2);
  }
</style>
