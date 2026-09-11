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
  import {
    ApiError,
    deleteScore,
    duplicateScore,
    getImport,
    listScores,
    OfflineError,
    submitImport,
  } from '../lib/api.js';
  import type { ImportJobView, ScoreListing } from '../lib/api.js';
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

  // The lifecycle actions (V8c). `confirmingId` is the one row asking to confirm a delete — delete
  // destroys the op log and cannot be undone (ADR-0003), so it asks first. `busyId` disables a row
  // mid-request. `freshId` is a just-made duplicate, marked until the next action so the eye finds
  // where it landed. `actionError` surfaces a refusal without disturbing the list.
  let confirmingId = $state<string | null>(null);
  let busyId = $state<string | null>(null);
  let freshId = $state<string | null>(null);
  let actionError = $state<string | null>(null);

  // The import affordance (V11): the browser's half of Q79 parity for `sbscore import`. `importing`
  // is the recogniser working (minutes, ADR-0025), `importNote` the line shown while it runs. A hidden
  // file input is clicked by the visible button, so the control reads as one button rather than a bare
  // file picker.
  let fileInput = $state<HTMLInputElement | null>(null);
  let importing = $state(false);
  let importNote = $state('');

  /** How often the browser polls the durable job while it runs (ADR-0001). */
  const IMPORT_POLL_MS = 800;

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

  /** Duplicate a chart, then re-read the list and mark the copy. Trust the id, never the list shape. */
  async function duplicate(id: string): Promise<void> {
    busyId = id;
    actionError = null;
    try {
      const result = await duplicateScore(id);
      await load();
      freshId = result.scoreId;
    } catch (error) {
      actionError = messageFor(error, 'duplicate');
    } finally {
      busyId = null;
    }
  }

  /** Delete after the row's own confirm. Irreversible — it destroys the log (ADR-0003). */
  async function confirmDelete(id: string): Promise<void> {
    busyId = id;
    actionError = null;
    try {
      await deleteScore(id);
      if (freshId === id) freshId = null;
      confirmingId = null;
      await load();
    } catch (error) {
      actionError = messageFor(error, 'delete');
    } finally {
      busyId = null;
    }
  }

  /**
   * Import one or more page images into a new draft chart (V11, Q26). Submit the files as one job,
   * poll it to a terminal status, then open the score it produced — or surface the diagnostic if the
   * recogniser failed (Q80) or the image had no staff (ADR-0018/Q28). Every parse is a draft
   * (ADR-0019); the score view is where it gets corrected.
   */
  async function runImport(files: File[]): Promise<void> {
    if (files.length === 0 || importing) return;
    importing = true;
    actionError = null;
    importNote = `Recognising ${files.length === 1 ? 'the page' : `${files.length} pages`}… this can take a minute.`;
    try {
      let job: ImportJobView = await submitImport(files);
      while (job.status === 'queued' || job.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, IMPORT_POLL_MS));
        job = await getImport(job.id);
      }
      if (job.status === 'failed') {
        actionError = `Import failed: ${job.diagnostic ?? 'unknown error'}`;
        return;
      }
      // A draft landed. Re-read the list so it appears, then open it for correction.
      await load();
      if (job.scoreId !== null) open(job.scoreId);
    } catch (error) {
      actionError = messageFor(error, 'import');
    } finally {
      importing = false;
      importNote = '';
    }
  }

  /** The hidden file input changed: gather the chosen images and import them, then reset it. */
  function onFilesChosen(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const files = input.files === null ? [] : Array.from(input.files);
    input.value = ''; // so choosing the same file again still fires `change`.
    void runImport(files);
  }

  function messageFor(error: unknown, verb: string): string {
    if (error instanceof OfflineError) return `Could not ${verb}: the server did not answer.`;
    if (error instanceof ApiError) return error.message;
    return error instanceof Error ? error.message : String(error);
  }

  void load();
</script>

<section class="library">
  <!-- One hidden picker, driven by every Import button below. `accept` hints images; the server is
       the real judge and decodes the bytes to validate them (ADR-0029). `multiple` is Q26. -->
  <input
    class="file-picker"
    type="file"
    accept="image/png,image/jpeg"
    multiple
    bind:this={fileInput}
    onchange={onFilesChosen}
    aria-hidden="true"
    tabindex="-1"
  />

  <div class="lib-head">
    <h1 class="lib-title">Library</h1>
    <div class="lib-head-right">
      <span class="lib-count">
        {#if charts === null || charts.length === 0}{:else if query.trim() === ''}
          {charts.length}
          {charts.length === 1 ? 'chart' : 'charts'}
        {:else}
          {shown.length} of {charts.length}
        {/if}
      </span>
      {#if failure === null}
        <button class="import-btn" onclick={() => fileInput?.click()} disabled={importing}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
            <path d="M8 10.5V2.5M5 5.5 8 2.5l3 3M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10" />
          </svg>
          {importing ? 'Importing…' : 'Import a photo'}
        </button>
      {/if}
    </div>
  </div>

  {#if importNote !== ''}
    <div class="import-note" role="status">
      <span class="spinner" aria-hidden="true"></span>{importNote}
    </div>
  {/if}

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
        Import a photo or scan of a lead sheet to turn it into an editable draft (every parse is a
        draft you correct, ADR-0019) — or author one in the terminal. Both talk to the same API, so a
        chart made either way opens here immediately.
      </p>
      <button class="import-btn big" onclick={() => fileInput?.click()} disabled={importing}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
          <path d="M8 10.5V2.5M5 5.5 8 2.5l3 3M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10" />
        </svg>
        {importing ? 'Importing…' : 'Import a photo'}
      </button>
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

    {#if actionError !== null}
      <div class="action-error" role="alert">{actionError}</div>
    {/if}

    <div class="rows">
      {#each shown as chart (chart.id)}
        <div class="row" class:fresh={freshId === chart.id}>
          <button class="open" onclick={() => open(chart.id)}>
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
              {#if freshId === chart.id}<span class="fresh-tag">duplicated</span>{/if}
              <span class="key-chip">{displayKey(chart.key)}</span>
              <span class="row-ver">v{chart.version}</span>
              <span class="row-when">{relativeTime(chart.updatedAt)}</span>
            </span>
          </button>

          {#if confirmingId === chart.id}
            <span class="confirm" role="group" aria-label="Confirm delete">
              <span class="warn">Delete this chart? Its edit history goes with it.</span>
              <button class="go" onclick={() => confirmDelete(chart.id)} disabled={busyId === chart.id}>
                Delete
              </button>
              <button class="cancel" onclick={() => (confirmingId = null)} disabled={busyId === chart.id}>
                Cancel
              </button>
            </span>
          {:else}
            <span class="actions">
              <button
                class="act dup"
                onclick={() => duplicate(chart.id)}
                disabled={busyId !== null}
                aria-label={`Duplicate ${chart.title === '' ? chart.id : chart.title}`}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                  <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
                  <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
                </svg>
                Duplicate
              </button>
              <button
                class="act del"
                onclick={() => {
                  confirmingId = chart.id;
                  actionError = null;
                }}
                disabled={busyId !== null}
                aria-label={`Delete ${chart.title === '' ? chart.id : chart.title}`}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                  <path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8" />
                </svg>
                Delete
              </button>
            </span>
          {/if}
        </div>
      {/each}
    </div>

    {#if shown.length === 0}
      <div class="state">
        <h2>No chart matches “{query.trim()}”.</h2>
        <p>The filter looks at title, composer and key. Clear it to see all charts.</p>
      </div>
    {/if}

    <div class="lib-foot">
      <span>Import a photo above, or author a chart in the terminal.</span>
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

  .lib-head-right {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  /* The one visible file picker is a button; the real <input> is offscreen but focusable-by-proxy. */
  .file-picker {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    border: 0;
  }

  .import-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: var(--panel-2);
    border: 1px solid var(--rule);
    border-radius: 3px;
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-soft);
    padding: 6px 12px;
    cursor: pointer;
    transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
  }
  .import-btn svg {
    width: 13px;
    height: 13px;
    flex: none;
  }
  .import-btn:hover:not(:disabled),
  .import-btn:focus-visible {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-wash);
  }
  .import-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .import-btn:disabled {
    cursor: default;
    opacity: 0.55;
  }
  .import-btn.big {
    font-size: 12px;
    padding: 9px 16px;
    margin-bottom: 8px;
  }

  .import-note {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 16px;
    padding: 10px 12px;
    font-size: 13px;
    color: var(--ink-soft);
    background: var(--accent-wash);
    border: 1px solid var(--rule);
  }
  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid var(--rule);
    border-top-color: var(--accent);
    border-radius: 50%;
    flex: none;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 2.4s;
    }
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

  .action-error {
    margin-top: 14px;
    padding: 10px 12px;
    font-size: 13px;
    color: var(--danger);
    background: var(--danger-wash);
    border: 1px solid var(--danger);
  }

  /* The row was a single <button>; a button cannot hold the action buttons, so it is now a grid
     whose name-and-meta is the one clickable "open" control and whose actions sit beside it (V8c). */
  .row {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 8px 14px;
    border-bottom: 1px solid var(--rule-soft);
    padding: 12px 12px 11px;
    margin: 0 -12px;
    position: relative;
  }
  .row::before {
    content: "";
    position: absolute;
    inset: 0;
    background: var(--accent-wash);
    opacity: 0;
    pointer-events: none;
  }
  .row:hover::before,
  .row:focus-within::before {
    opacity: 1;
  }
  .row > :global(*) {
    position: relative;
  }

  /* The open control: the whole name + meta block, a transparent button. */
  .open {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: baseline;
    gap: 6px 20px;
    min-width: 0;
    background: none;
    border: 0;
    padding: 5px 0;
    margin: 0;
    text-align: left;
    cursor: pointer;
    color: inherit;
    font: inherit;
  }
  .open:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
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

  /* The two per-row actions, quiet until the row is hovered or something in it is focused — so a
     resting list reads as cleanly as it did before this slice, then the actions fade in. */
  .actions {
    display: flex;
    gap: 2px;
    align-items: center;
  }
  .act {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: 1px solid transparent;
    border-radius: 3px;
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-faint);
    padding: 5px 9px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 120ms ease, color 120ms ease, border-color 120ms ease, background 120ms ease;
  }
  .row:hover .act,
  .row:focus-within .act {
    opacity: 1;
  }
  .act svg {
    width: 13px;
    height: 13px;
    flex: none;
  }
  .act.dup:hover,
  .act.dup:focus-visible {
    color: var(--accent);
    border-color: var(--rule);
    background: var(--panel-2);
  }
  .act.del:hover,
  .act.del:focus-visible {
    color: var(--danger);
    border-color: var(--danger);
    background: var(--danger-wash);
  }
  .act:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .act:disabled {
    cursor: default;
    opacity: 0.4;
  }

  /* Delete is irreversible, so it asks inline — replacing the actions rather than floating a popover
     a keyboard user has to chase. */
  .confirm {
    display: flex;
    align-items: center;
    gap: 10px;
    justify-self: end;
    font-family: var(--mono);
    font-size: 11px;
  }
  .confirm .warn {
    font-family: var(--serif);
    font-style: italic;
    font-size: 12.5px;
    color: var(--ink-faint);
  }
  .confirm button {
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    border-radius: 3px;
    padding: 5px 11px;
    cursor: pointer;
  }
  .confirm .go {
    background: var(--danger);
    border: 1px solid var(--danger);
    color: var(--panel);
  }
  .confirm .cancel {
    background: none;
    border: 1px solid var(--rule);
    color: var(--ink-soft);
  }
  .confirm button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .confirm button:disabled {
    cursor: default;
    opacity: 0.5;
  }

  /* A just-duplicated row: a one-shot wash so the eye finds where the copy landed, and a small tag. */
  .row.fresh {
    animation: settle 1.4s ease;
  }
  @keyframes settle {
    from {
      background: var(--accent-wash);
    }
    to {
      background: transparent;
    }
  }
  .fresh-tag {
    font-family: var(--mono);
    font-size: 9.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 2px;
    padding: 1px 5px;
  }
  @media (prefers-reduced-motion: reduce) {
    .row.fresh {
      animation: none;
    }
    .act {
      transition: none;
    }
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
    .open {
      grid-template-columns: 1fr;
    }
    .row-meta {
      justify-content: flex-start;
    }
    .row-when {
      text-align: left;
      min-width: 0;
    }
    /* No hover on touch, so the actions stay visible rather than hiding behind a gesture. */
    .act {
      opacity: 1;
    }
    .confirm {
      justify-self: start;
      flex-wrap: wrap;
    }
  }
</style>
