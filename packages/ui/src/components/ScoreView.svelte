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
   * **Selection and the inspector are V4c.** A click on the sheet hit-tests against the exact
   * geometry the engraver drew from (`../lib/hit-test.js`), never a second opinion about where
   * anything sits. Saving submits an op to the same `/v1/scores/:id/ops` the CLI uses — there is
   * no second write path — and a stale write recovers by reloading, never by retrying with the
   * server's version (ADR-0003).
   */
  import { DEFAULT_MUSIC_FONT } from '@sibei/engrave';
  import type { MusicFontName } from '@sibei/engrave';
  import type { Paper } from '@sibei/layout';
  import { formatKeySignature, formatPitch, NEEDS_REVIEW, reviewSummary } from '@sibei/model';
  import type { Id, Score } from '@sibei/model';
  import {
    ApiError,
    exportRoute,
    exportUrl,
    FONTS,
    getScore,
    OfflineError,
    PAPERS,
    submitOps,
  } from '../lib/api.js';
  import type { Operation } from '../lib/api.js';
  import { SERVE_COMMAND } from '../lib/branding.js';
  import { watchScore } from '../lib/events.js';
  import { absoluteTime, displayKey, formatBarRanges, paperLabel } from '../lib/format.js';
  import { boxFor, findItem, hitTest, loadFont, pageItemBoxes } from '../lib/hit-test.js';
  import type { Point } from '../lib/hit-test.js';
  import { renderScorePages } from '../lib/render.js';
  import Inspector from './Inspector.svelte';
  import type { NoteEdits, RestEdits, Selection } from './Inspector.svelte';
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

  // Selection (V4c). The id is the whole of it — everything the inspector shows is looked up
  // fresh from the current render each time, never cached at selection time, so a reload never
  // leaves it holding a stale copy of what it is inspecting.
  let selectedId = $state<Id | null>(null);
  let selectedPage = $state<number | null>(null);
  let conflict = $state(false);
  let saving = $state(false);
  let saveError = $state<string | null>(null);

  // The whole render, re-run when the score, the paper or the face changes — which is what makes
  // the switches change the page rather than only the URL.
  const pages = $derived(
    score === null ? [] : renderScorePages(score, { paper }, { font }),
  );
  const review = $derived(score === null ? null : reviewSummary(score));
  const bars = $derived(score === null ? 0 : score.bars.filter((bar) => bar.number !== 0).length);
  const route = $derived(exportRoute({ paper, font }));

  // The same font metrics `pages` above just rendered from — hit-testing calls the engraver's
  // own geometry functions with it rather than a second copy of them (../lib/hit-test.js).
  const musicFont = $derived(loadFont(font));

  const located = $derived.by(() => {
    if (selectedId === null || selectedPage === null) return null;
    const page = pages[selectedPage];
    if (page === undefined) return null;
    return findItem(page.layout, selectedId);
  });

  const selection = $derived.by((): Selection | null => {
    if (located === null) return null;
    const { item } = located;
    if (item.kind === 'note') {
      return {
        kind: 'note',
        id: item.noteId,
        pitch: formatPitch(item.pitch),
        duration: item.duration,
        accidental: item.accidental,
        tie: item.tie,
      };
    }
    return { kind: 'rest', id: item.restId, duration: item.duration };
  });

  const selectionOverlay = $derived.by(() => {
    if (selectedId === null || selectedPage === null) return null;
    const page = pages[selectedPage];
    if (page === undefined) return null;
    const box = boxFor(pageItemBoxes(page.layout, musicFont), selectedId);
    return box === null ? null : { pageIndex: selectedPage, box };
  });

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

  function deselect(): void {
    selectedId = null;
    selectedPage = null;
    conflict = false;
    saveError = null;
  }

  /**
   * A click on a sheet, in that page's own layout units (`SheetStack` did the pixel-to-unit
   * arithmetic; this is where musical meaning is decided). Missing everything counts as a
   * deselect — clicking white space is how the mockup's "Deselect" affordance behaves without a
   * second control for it.
   */
  function handleSheetClick(pageIndex: number, point: Point): void {
    if (saving) return;
    const page = pages[pageIndex];
    if (page === undefined) return;
    const hit = hitTest(pageItemBoxes(page.layout, musicFont), point);
    conflict = false;
    saveError = null;
    if (hit === null) {
      selectedId = null;
      selectedPage = null;
      return;
    }
    selectedId = hit.id;
    selectedPage = pageIndex;
  }

  /**
   * `note.set` for a note; `rest.rm` + `rest.add` in one batch for a rest, because there is no
   * `rest.set` verb and inventing one is a slice-level decision this card does not get to make
   * (KAN-589). The add's target is a position — `bar12.beat3` — because the rm just freed that
   * beat and the new rest has no id yet to address by.
   *
   * Success re-reads the score rather than trusting `ApplyResult`'s content, the same reasoning
   * as the SSE event payload: this response says an edit landed, not what the chart now says.
   * A 409 is the one path that does not re-read — it shows the conflict panel, and reloading is
   * the only way out of it (ADR-0003).
   */
  async function handleSave(edits: NoteEdits | RestEdits): Promise<void> {
    if (score === null || located === null || selectedId === null) return;

    const operations: Operation[] =
      located.item.kind === 'note'
        ? [{ type: 'note.set', target: selectedId, payload: edits as NoteEdits }]
        : [
            { type: 'rest.rm', target: selectedId },
            {
              type: 'rest.add',
              target: `bar${located.barNumber}.beat${located.item.beat}`,
              payload: { duration: (edits as RestEdits).duration },
            },
          ];

    saving = true;
    saveError = null;
    try {
      await submitOps(score.id, { operations, expectedVersion: version });
      await load();
      deselect();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        conflict = true;
        return;
      }
      saveError = error instanceof Error ? error.message : String(error);
    } finally {
      saving = false;
    }
  }

  async function handleReload(): Promise<void> {
    deselect();
    await load();
  }

  /**
   * Live updates (V4d, SLICES.md V4 step 5). One stream per mounted chart: `App.svelte` keys this
   * component on the id, so `id` is fixed here and the effect opens exactly one connection and
   * closes it on unmount (the teardown `watchScore` returns is the effect's cleanup).
   *
   * A `changed` frame carries the version that now exists. If that is not the version on screen,
   * re-read — the same recovery `handleSave` runs, and what the server's `{version}`-only payload
   * was shaped for (`change-bus.ts`). Three frames are deliberately no-ops: the stream's opening
   * catch-up frame (its version is the one we just loaded), a change we made ourselves (`load`
   * already moved us there), and any frame that lands mid-save — that one is left to the save's own
   * re-read rather than raced with it. A `deleted` frame means the chart is gone; there is no
   * version to re-read to, so it becomes the same "no chart with that id" state a 404 does.
   */
  $effect(() =>
    watchScore(id, {
      onChanged: (incoming) => {
        if (score !== null && !saving && incoming !== version) void load();
      },
      onDeleted: () => {
        score = null;
        onTitle(null);
        deselect();
        failure = { kind: 'missing', message: 'this chart was deleted.' };
      },
    }),
  );

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
        <!-- `anythingFlagged` is the model's single answer, and until KAN-597 it was not: it read
             the *stored* `bar.review.flagged` while the two lines below derived the same fact from
             the bar's contents, so this branch printed "Nothing flagged." over a chart with two
             invalid bars. Every chart authored through the API was right — the applier stamps the
             flag on write — so it was correct exactly where anyone looked. Nothing about the branch
             changes; the answer it asks for does. -->
        {#if review === null || !review.anythingFlagged}
          <p class="review-ok">Nothing flagged.</p>
        {:else}
          <!-- The wording is the model's, not this component's: `reviewSummary` is what the text
               projection prints too, so the two surfaces cannot describe the same chart in two
               vocabularies. A blank chart now reports nothing, which is why the first thing a new
               user sees is no longer a chart entirely in review. -->
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

      <div class="group">
        <h3>Selected</h3>
        {#if selection === null}
          <p class="inspector-empty">Nothing selected. Click a note or a rest on the sheet to edit it.</p>
        {:else}
          {#key selection.id}
            <Inspector
              {selection}
              {conflict}
              {saving}
              error={saveError}
              onsave={handleSave}
              ondeselect={deselect}
              onreload={handleReload}
            />
          {/key}
        {/if}
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
        <SheetStack {pages} selection={selectionOverlay} onselect={handleSheetClick} />
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

  .inspector-empty {
    font-size: 12px;
    color: var(--ink-faint);
    line-height: 1.6;
    margin: 0;
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
