<script lang="ts">
  /**
   * The library: every chart the local store holds, filtered by title, composer or key.
   *
   * It reads `GET /v1/scores`, which serves the columns the store extracts beside the document
   * (ADR-0006) — so drawing this list deserialises no charts, and it cannot drift from what it
   * lists because those columns are derived on every write. Six fields is all there is: anything
   * more (bar count, page count, review state) needs the document, and that is the score view's
   * request to make.
   *
   * **There is no "New chart" button, and that is the card's shape rather than an oversight.**
   * The UI's first write is V4c's whole subject, so the library points at the terminal instead —
   * in the empty state, and in a footer that stays put once there are charts, because the
   * library is where you notice you want another one. Q79 parity is knowingly unmet until V4c.
   */
  import { listScores, OfflineError } from '../lib/api.js';
  import type { ScoreListing } from '../lib/api.js';
  import { NEW_CHART_COMMAND, SERVE_COMMAND } from '../lib/branding.js';
  import { displayKey, relativeTime } from '../lib/format.js';
  import { hashOf } from '../lib/routing.js';

  interface Props {
    onReachable: (reachable: boolean) => void;
  }

  const { onReachable }: Props = $props();

  let charts = $state<ScoreListing[] | null>(null);
  let failure = $state<'offline' | 'error' | null>(null);
  let message = $state('');
  let query = $state('');

  const shown = $derived(filtered(charts ?? [], query));

  async function load(): Promise<void> {
    try {
      charts = await listScores();
      failure = null;
      onReachable(true);
    } catch (error) {
      charts = [];
      failure = error instanceof OfflineError ? 'offline' : 'error';
      message = error instanceof Error ? error.message : String(error);
      onReachable(false);
    }
  }

  /** Title, composer or key. A key matches on prefix so `E` finds `Eb` and `Ebm`. */
  function filtered(all: ScoreListing[], q: string): ScoreListing[] {
    const needle = q.trim().toLowerCase();
    if (needle === '') return all;
    return all.filter(
      (chart) =>
        (chart.title === '' ? 'untitled' : chart.title).toLowerCase().includes(needle) ||
        chart.composer.toLowerCase().includes(needle) ||
        chart.key.toLowerCase().startsWith(needle),
    );
  }

  function open(id: string): void {
    window.location.hash = hashOf({ view: 'score', id });
  }

  void load();
</script>

<section class="library">
  <div class="lib-head">
    <h1 class="lib-title">Library</h1>
    <span class="lib-count">
      {#if charts === null || charts.length === 0}{:else if query.trim() === ''}
        {charts.length}
        {charts.length === 1 ? 'chart' : 'charts'}
      {:else}
        {shown.length} of {charts.length}
      {/if}
    </span>
  </div>

  {#if failure !== null}
    <!-- Not a state the mockup has: it only ever drew a running server. The distinction it
         cannot draw is the one a reader most needs — an empty library and an unreachable one
         look identical, and only one of them is fixed by typing a command. -->
    <div class="state">
      <h2>{failure === 'offline' ? 'No answer from the server.' : 'The server refused that.'}</h2>
      <p>
        {#if failure === 'offline'}
          Nothing is listening where this page expects the API. Start it, then reload — the
          browser and the terminal are two clients of the same one (ADR-0002).
        {:else}
          {message}
        {/if}
      </p>
      {#if failure === 'offline'}
        <div class="term"><span class="prompt">{'$ '}</span>{SERVE_COMMAND}</div>
      {/if}
    </div>
  {:else if charts !== null && charts.length === 0}
    <div class="state">
      <h2>No charts yet.</h2>
      <p>
        This build reads charts. Writing one is the CLI's job for now — the two surfaces talk to
        the same API, so a chart made in the terminal opens here immediately.
      </p>
      <div class="term"><span class="prompt">{'$ '}</span>{NEW_CHART_COMMAND}</div>
    </div>
  {:else}
    <div class="search-wrap">
      <svg
        class="search-glyph"
        viewBox="0 0 16 16"
        width="15"
        height="15"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
      >
        <circle cx="7" cy="7" r="4.6" />
        <path d="M10.4 10.4 14 14" />
      </svg>
      <input
        id="search"
        type="text"
        placeholder="Filter by title, composer or key"
        autocomplete="off"
        aria-label="Filter charts"
        bind:value={query}
      />
      {#if query !== ''}
        <button class="search-clear" onclick={() => (query = '')}>Clear</button>
      {/if}
    </div>

    <div class="rows">
      {#each shown as chart (chart.id)}
        <button class="row" onclick={() => open(chart.id)}>
          <span class="row-name">
            {#if chart.title === ''}
              <span><em>Untitled</em></span>
              <span class="row-id">{chart.id}</span>
            {:else}
              <span>{chart.title}</span>
            {/if}
            {#if chart.composer !== ''}<span class="row-by">{chart.composer}</span>{/if}
          </span>
          <span class="row-meta">
            <span class="key-chip">{displayKey(chart.key)}</span>
            <span class="row-ver">v{chart.version}</span>
            <span class="row-when">{relativeTime(chart.updatedAt)}</span>
            <span class="row-go" aria-hidden="true">›</span>
          </span>
        </button>
      {/each}
    </div>

    {#if shown.length === 0}
      <div class="state">
        <h2>No chart matches “{query.trim()}”.</h2>
        <p>The filter looks at title, composer and key. Clear it to see all charts.</p>
      </div>
    {/if}

    <div class="lib-foot">
      <span>New charts come from the terminal.</span>
      <code>{NEW_CHART_COMMAND}</code>
    </div>
  {/if}
</section>

<style>
  /* The library sits on a surface on the same desk the sheet sits on, so the two views share one
     metaphor: the ground is the desk, the content is an object on it. */
  .library {
    max-width: 920px;
    margin: 0 auto;
    padding: 46px 46px 120px;
    background: var(--panel);
    border-inline: 1px solid var(--rule);
    min-height: calc(100vh - var(--top-h));
  }

  .lib-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 24px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--rule);
  }

  .lib-title {
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--ink-soft);
    margin: 0;
    font-weight: 600;
  }

  .lib-count {
    font-size: 11px;
    color: var(--ink-faint);
    letter-spacing: 0.05em;
    font-variant-numeric: tabular-nums;
  }

  .search-wrap {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 22px;
    padding: 0 0 10px;
    border-bottom: 1px solid var(--rule-soft);
  }
  .search-wrap:focus-within {
    border-bottom-color: var(--accent);
  }

  .search-glyph {
    color: var(--ink-faint);
    flex: none;
  }

  #search {
    flex: 1;
    min-width: 0;
    background: none;
    border: 0;
    padding: 4px 0;
    font-size: 15px;
    letter-spacing: 0.01em;
  }
  #search::placeholder {
    color: var(--ink-faint);
  }
  #search:focus {
    outline: none;
  }

  .search-clear {
    background: none;
    border: 0;
    cursor: pointer;
    font-size: 11px;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--ink-faint);
    padding: 2px 4px;
  }
  .search-clear:hover {
    color: var(--accent);
  }

  .rows {
    margin-top: 6px;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: baseline;
    gap: 8px 20px;
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    border-bottom: 1px solid var(--rule-soft);
    padding: 17px 12px 16px;
    margin: 0 -12px;
    cursor: pointer;
    position: relative;
  }
  .row::before {
    content: "";
    position: absolute;
    inset: 0;
    background: var(--accent-wash);
    opacity: 0;
  }
  .row:hover::before,
  .row:focus-visible::before {
    opacity: 1;
  }
  .row > :global(*) {
    position: relative;
  }

  .row-name {
    font-family: var(--serif);
    font-size: 21px;
    line-height: 1.2;
    color: var(--ink);
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
  }
  .row-name :global(em) {
    font-style: italic;
    color: var(--ink-faint);
  }
  .row-by {
    font-family: var(--serif);
    font-size: 15px;
    font-style: italic;
    color: var(--ink-soft);
  }
  .row-id {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink-faint);
    letter-spacing: 0.02em;
  }

  .row-meta {
    display: flex;
    align-items: baseline;
    gap: 16px;
    font-size: 11.5px;
    color: var(--ink-faint);
    letter-spacing: 0.04em;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .key-chip {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--ink);
    background: var(--panel-2);
    border: 1px solid var(--rule);
    padding: 2px 8px 3px;
    min-width: 42px;
    text-align: center;
    display: inline-block;
  }

  .row-ver {
    color: var(--ink-faint);
  }
  .row-when {
    min-width: 92px;
    text-align: right;
  }

  .row-go {
    color: var(--accent);
    opacity: 0;
    font-size: 14px;
    width: 10px;
    text-align: right;
  }
  .row:hover .row-go,
  .row:focus-visible .row-go {
    opacity: 1;
  }

  .lib-foot {
    margin-top: 42px;
    padding-top: 16px;
    border-top: 1px solid var(--rule-soft);
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 14px;
    font-size: 11.5px;
    color: var(--ink-faint);
    letter-spacing: 0.03em;
  }
  .lib-foot code {
    font-family: var(--mono);
    color: var(--ink-soft);
    background: var(--panel-2);
    border: 1px solid var(--rule-soft);
    padding: 3px 8px;
  }

  @media (max-width: 900px) {
    .library {
      padding: 32px 18px 150px;
      border-inline: 0;
    }
    .row {
      grid-template-columns: 1fr;
    }
    .row-meta {
      justify-content: flex-start;
    }
    .row-when {
      text-align: left;
      min-width: 0;
    }
  }
</style>
