<script lang="ts">
  /**
   * One chart: the rail, and the pages.
   *
   * The chart is fetched once from `GET /v1/scores/:id` and rendered in the browser through
   * `layout()` + `engravePage()` — **the same two packages the PDF goes through** (ADR-0014,
   * ADR-0015). Nothing here is a second opinion about the page.
   *
   * **The rail is not a sidebar of metadata; it is the half of the chart the engraving cannot
   * say.** The face and the paper change the sheet above *and* the export URL below, because
   * they are one render-time choice and not two settings (ADR-0030, Q38). And review state has
   * nowhere else to go: an under-filled bar and a correct one are the same ink, so the engraver
   * draws no flag, and if the chrome does not say it nobody ever finds out (ADR-0013).
   *
   * Read-only, deliberately. No selection, no hit-testing, no inspector — V4c. The room below
   * the export block is where the inspector goes.
   */
  import { DEFAULT_MUSIC_FONT } from '@sibei/engrave';
  import type { MusicFontName } from '@sibei/engrave';
  import type { Paper } from '@sibei/layout';
  import { formatKeySignature, NEEDS_REVIEW, reviewSummary } from '@sibei/model';
  import type { Score } from '@sibei/model';
  import { ApiError, exportRoute, exportUrl, FONTS, getScore, OfflineError, PAPERS } from '../lib/api.js';
  import { SERVE_COMMAND } from '../lib/branding.js';
  import { absoluteTime, displayKey, formatBarRanges, paperLabel } from '../lib/format.js';
  import { renderScorePages } from '../lib/render.js';
  import SegmentedControl from './SegmentedControl.svelte';
  import SheetStack from './SheetStack.svelte';

  interface Props {
    id: string;
    /** The loaded chart's title, for the breadcrumb. `''` is untitled; `null` is not loaded. */
    onTitle: (title: string | null) => void;
    onReachable: (reachable: boolean) => void;
  }

  const { id, onTitle, onReachable }: Props = $props();

  /** A4 and `normal` are the API's defaults too, so the first render matches the default export. */
  const DEFAULT_PAPER: Paper = 'a4';

  /** 60% to 200%, in steps of 20. A document viewer's range, not a design tool's. */
  const ZOOM_MIN = 60;
  const ZOOM_MAX = 200;
  const ZOOM_STEP = 20;
  /** The sheet's width at 100%. */
  const SHEET_WIDTH = 780;

  let score = $state<Score | null>(null);
  let version = $state(0);
  let updatedAt = $state('');
  let failure = $state<{ kind: 'offline' | 'missing' | 'error'; message: string } | null>(null);

  let paper = $state<Paper>(DEFAULT_PAPER);
  let font = $state<MusicFontName>(DEFAULT_MUSIC_FONT);
  let zoom = $state(100);

  // The whole render, re-run when the score, the paper or the face changes — which is what makes
  // the switches change the page rather than only the URL.
  const pages = $derived(
    score === null ? [] : renderScorePages(score, { paper }, { font }),
  );
  const review = $derived(score === null ? null : reviewSummary(score));
  const bars = $derived(score === null ? 0 : score.bars.filter((bar) => bar.number !== 0).length);
  const route = $derived(exportRoute({ paper, font }));

  async function load(): Promise<void> {
    try {
      const record = await getScore(id);
      score = record.score;
      version = record.version;
      updatedAt = record.updatedAt;
      failure = null;
      onTitle(record.score.meta.title);
      onReachable(true);
    } catch (error) {
      score = null;
      onTitle(null);
      if (error instanceof OfflineError) {
        failure = { kind: 'offline', message: error.message };
        onReachable(false);
        return;
      }
      onReachable(true);
      if (error instanceof ApiError && error.status === 404) {
        failure = { kind: 'missing', message: error.message };
        return;
      }
      failure = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }

  function stepZoom(by: number): void {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom + by));
  }

  void load();
</script>

{#if failure !== null}
  <div class="failure">
    <div class="state">
      <h2>
        {#if failure.kind === 'offline'}No answer from the server.
        {:else if failure.kind === 'missing'}No chart with that id.
        {:else}The server refused that.{/if}
      </h2>
      <p>{failure.message}</p>
      {#if failure.kind === 'offline'}
        <div class="term"><span class="prompt">{'$ '}</span>{SERVE_COMMAND}</div>
      {/if}
    </div>
  </div>
{:else if score !== null}
  <section class="score">
    <aside class="rail">
      <div>
        <h2 class="rail-title" class:untitled={score.meta.title === ''}>
          {score.meta.title === '' ? 'Untitled' : score.meta.title}
        </h2>
        {#if score.meta.composer !== ''}
          <p class="rail-by">{score.meta.composer}</p>
        {/if}
      </div>

      <!-- Deliberately not repeating `style` here — it is printed on the page, two centimetres
           away. The rail carries what the page cannot say. -->
      <dl class="facts">
        <dt>key</dt>
        <dd>{displayKey(formatKeySignature(score.meta.key))}</dd>
        <dt>time</dt>
        <dd>{score.meta.time.beats}/{score.meta.time.beatValue}</dd>
        <dt>bars</dt>
        <dd>{bars}</dd>
        <dt>pages</dt>
        <dd>{pages.length} · {paperLabel(paper)}</dd>
        <dt>version</dt>
        <dd>v{version}</dd>
        <dt>updated</dt>
        <dd>{absoluteTime(updatedAt)}</dd>
        <dt>id</dt>
        <dd class="id">{score.id}</dd>
      </dl>

      <div class="group">
        <h3>Review</h3>
        {#if review === null || !review.anythingFlagged}
          <p class="review-ok">Nothing flagged.</p>
        {:else}
          <!-- The wording is the model's, not this component's: `reviewSummary` is what the text
               projection prints too, so the two surfaces cannot describe the same chart in two
               vocabularies — and KAN-597's change to how a blank chart reports lands here for
               free. -->
          <div class="review-flag">
            <span class="bang">!</span>{review.meterNote ?? NEEDS_REVIEW}
            {#if review.invalidBars.length > 0}
              <span class="bars">{formatBarRanges(review.invalidBars)}</span>
            {/if}
          </div>
        {/if}
      </div>

      <div class="group control-row">
        <h3>Face</h3>
        <SegmentedControl
          label="Music face"
          options={FONTS}
          value={font}
          onselect={(chosen) => (font = chosen)}
        />
        <p class="control-note">
          Bravura, engraved · Petaluma, the handwritten Real Book face. The face is chosen per
          render, not per chart.
        </p>
      </div>

      <div class="group control-row">
        <h3>Paper</h3>
        <SegmentedControl
          label="Paper size"
          options={PAPERS}
          value={paper}
          display={paperLabel}
          onselect={(chosen) => (paper = chosen)}
        />
        <p class="control-note">Paper changes the line breaks, so the page above changes with it.</p>
      </div>

      <div class="group">
        <h3>Export</h3>
        <a class="export" href={exportUrl(score.id, { paper, font })} download>Export PDF</a>
        <!-- The route, not the instance: the id is already in the facts above, and a
             40-character id wraps this column into nonsense. -->
        <p class="url">
          <span class="u-path">{route.path}</span>
          <span class="u-q">{route.query}</span>
        </p>
      </div>
    </aside>

    <div class="stage" style="--sheet-w: {(SHEET_WIDTH * zoom) / 100}px">
      <div class="stage-inner">
        <div class="stage-bar">
          <span>{pages.length} {pages.length === 1 ? 'page' : 'pages'}</span>
          <div class="zoom" role="group" aria-label="Zoom">
            <button
              aria-label="Zoom out"
              disabled={zoom <= ZOOM_MIN}
              onclick={() => stepZoom(-ZOOM_STEP)}>−</button
            >
            <span class="val">{zoom}%</span>
            <button
              aria-label="Zoom in"
              disabled={zoom >= ZOOM_MAX}
              onclick={() => stepZoom(ZOOM_STEP)}>+</button
            >
          </div>
        </div>
        <SheetStack {pages} />
      </div>
    </div>
  </section>
{/if}

<style>
  /* Same surface the library's own failure sits on, so a stopped server looks the same wherever
     you were standing when it stopped. */
  .failure {
    max-width: 920px;
    margin: 0 auto;
    padding: 0 46px 120px;
    background: var(--panel);
    border-inline: 1px solid var(--rule);
    min-height: calc(100vh - var(--top-h));
  }

  .score {
    display: grid;
    grid-template-columns: var(--rail-w) 1fr;
    align-items: start;
    min-height: calc(100vh - var(--top-h));
  }

  .rail {
    position: sticky;
    top: var(--top-h);
    align-self: start;
    height: calc(100vh - var(--top-h));
    overflow-y: auto;
    background: var(--panel);
    border-right: 1px solid var(--rule);
    padding: 26px 22px 40px;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .rail-title {
    font-family: var(--serif);
    font-size: 24px;
    line-height: 1.15;
    margin: 0;
    font-weight: 400;
    text-wrap: balance;
  }
  .rail-title.untitled {
    font-style: italic;
    color: var(--ink-faint);
  }
  .rail-by {
    font-family: var(--serif);
    font-style: italic;
    font-size: 15px;
    color: var(--ink-soft);
    margin: 5px 0 0;
  }

  .facts {
    display: grid;
    grid-template-columns: 62px 1fr;
    gap: 5px 12px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .facts dt {
    color: var(--ink-faint);
    letter-spacing: 0.06em;
    text-transform: lowercase;
  }
  .facts dd {
    margin: 0;
    color: var(--ink);
  }
  .facts dd.id {
    font-size: 11px;
    color: var(--ink-soft);
    word-break: break-all;
  }

  .group {
    border-top: 1px solid var(--rule);
    padding-top: 15px;
  }
  .group > h3 {
    font-size: 10.5px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--ink-faint);
    margin: 0 0 10px;
    font-weight: 600;
  }

  /* the review block carries what the engraving cannot say, in the same words
     `sbscore show` prints (ADR-0009) */
  .review-ok {
    color: var(--ink-soft);
    font-size: 12px;
    margin: 0;
  }
  .review-flag {
    background: var(--flag-wash);
    border-left: 2px solid var(--flag);
    padding: 9px 11px;
    font-size: 12px;
    line-height: 1.55;
  }
  .review-flag .bang {
    color: var(--flag);
    font-weight: 700;
    margin-right: 6px;
  }
  .review-flag .bars {
    display: block;
    margin-top: 6px;
    color: var(--ink-faint);
    font-size: 11px;
    letter-spacing: 0.03em;
  }

  .control-row {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .control-note {
    font-size: 11px;
    color: var(--ink-faint);
    line-height: 1.5;
    margin: 0;
  }

  .export {
    display: block;
    width: 100%;
    text-align: center;
    background: var(--accent);
    border: 0;
    padding: 10px 14px;
    cursor: pointer;
    font-size: 12px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    font-weight: 600;
    color: var(--on-accent);
    text-decoration: none;
  }
  .export:hover {
    filter: brightness(1.08);
  }

  .url {
    font-size: 10.5px;
    color: var(--ink-faint);
    margin: 8px 0 0;
    line-height: 1.6;
  }
  .url span {
    display: block;
  }
  .url .u-path {
    word-break: break-all;
  }
  .url .u-q {
    color: var(--ink-soft);
  }

  /* The stage scrolls sideways rather than the page body, so zooming past the window width is a
     document-viewer scroll and never a broken layout. */
  .stage {
    --sheet-w: 780px;
    padding: 34px 34px 110px;
    min-width: 0;
    overflow-x: auto;
  }

  .stage-inner {
    width: fit-content;
    min-width: 100%;
    margin-inline: auto;
  }

  .stage-bar {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 14px;
    margin-bottom: 18px;
    font-size: 11px;
    color: var(--ink-faint);
    letter-spacing: 0.05em;
  }
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

  @media (max-width: 900px) {
    .score {
      grid-template-columns: 1fr;
    }
    .rail {
      position: static;
      height: auto;
      border-right: 0;
      border-bottom: 1px solid var(--rule);
    }
    .stage {
      padding: 22px 14px 150px;
    }
  }
</style>
