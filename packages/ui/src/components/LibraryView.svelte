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
   * **New chart (SIB2-270)** is the browser's `sbscore new`: a small form (title, key, time, bars,
   * pickup, and an instrument picker, SIB2-288) that sends the same `score.create`, and an Open a sample chart link that sends one
   * `score.create` plus twelve `chord.set`s in one batch. With it every capability has both surfaces.
   */
  import {
    ApiError,
    createScore,
    deleteScore,
    duplicateScore,
    getImport,
    listScores,
    OfflineError,
    SIGN_IN_PATH,
    submitImport,
    submitNoteEvents,
    isNoteEventsFile,
    submitMusicXml,
    isMusicXmlFile,
  } from '../lib/api.js';
  import { UNTITLED } from '@sibei/model';
  import InstrumentPicker from './InstrumentPicker.svelte';
  import type { ImportJobView, ScoreListing } from '../lib/api.js';
  import { splitPointOf } from '../lib/staff-edits.js';
  import { getMe } from '../lib/api.js';
  import { NEW_CHART_COMMAND, SERVE_COMMAND } from '../lib/branding.js';
  import { rememberReturn } from '../lib/session.js';
  import { displayId, displayKey, relativeTime } from '../lib/format.js';
  import { AUDIO, hashOf } from '../lib/routing.js';
  import {
    chartId,
    KEY_CHOICES,
    MAX_BARS,
    MIN_BARS,
    newChartOps,
    problemWith,
    sampleChartOps,
    TIME_CHOICES,
  } from '../lib/new-chart.js';

  interface Props {
    onReachable: (reachable: boolean) => void;
  }

  const { onReachable }: Props = $props();

  let charts = $state<ScoreListing[] | null>(null);
  let failure = $state<'offline' | 'signed-out' | 'error' | null>(null);
  let message = $state('');
  let query = $state('');
  // Sort order (SIB2-271), remembered per browser: most recently edited first, or A to Z by title.
  const SORT_KEY = 'sibei.librarySort';
  type Sort = 'recent' | 'title';
  function storedSort(): Sort {
    try {
      return window.localStorage.getItem(SORT_KEY) === 'title' ? 'title' : 'recent';
    } catch {
      return 'recent';
    }
  }
  let sort = $state<Sort>(storedSort());
  function chooseSort(next: Sort): void {
    sort = next;
    try {
      window.localStorage.setItem(SORT_KEY, next);
    } catch {
      // storage can be blocked; the choice then lasts the session
    }
  }

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
  // Where a piano file's hands pivot (SIB2-244); blank is middle C.
  let splitText = $state('');
  let importNote = $state('');
  // What a MusicXML import could not keep (SIB2-152): shown, with a way in, instead of opening the draft silently.
  let importReport = $state<{ scoreId: string; lines: string[] } | null>(null);
  // Whether this service takes photos (SIB2-201). Optimistic until `/v1/me` says otherwise, so a local
  // install never flashes the notice; when it is off the picker offers only a NoteEvents .json.
  let photoImport = $state(true);
  void getMe()
    .then((me) => (photoImport = me.photoImport !== false))
    .catch(() => {});

  /** How often the browser polls the durable job while it runs (ADR-0001). */
  const IMPORT_POLL_MS = 800;

  const shown = $derived(sorted(filtered(charts ?? [], query), sort));

  function rememberHere(): void {
    try {
      rememberReturn(window.location.hash, window.sessionStorage);
    } catch {
      // sessionStorage can be blocked; the person lands in the library afterwards
    }
  }

  async function load(): Promise<void> {
    try {
      charts = await listScores();
      failure = null;
      onReachable(true);
    } catch (error) {
      charts = [];
      failure =
        error instanceof OfflineError ? 'offline' : error instanceof ApiError && error.status === 401 ? 'signed-out' : 'error';
      message = error instanceof Error ? error.message : String(error);
      onReachable(false);
    }
  }

  function sorted(rows: ScoreListing[], by: Sort): ScoreListing[] {
    const copy = [...rows];
    if (by === 'title') {
      // Untitled charts sort last, under the word the list shows for them.
      const name = (chart: ScoreListing): string => (chart.title === '' ? '\uffff' : chart.title.toLowerCase());
      return copy.sort((a, b) => name(a).localeCompare(name(b)));
    }
    return copy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
    importReport = null;
    const musicXml = files.length === 1 && isMusicXmlFile(files[0]!);
    // A single .json is an audio engine's NoteEvents (ADR-0040): quick, and no recogniser involved.
    // Several .json files are one stem each of one recording (SIB2-147).
    const noteEvents = files.every(isNoteEventsFile);
    // The piano hand-split pivot (SIB2-244): typed as a number or a pitch, blank for the default, used only by a NoteEvents file.
    const splitPointValue = splitText.trim() === '' || !noteEvents ? undefined : (splitPointOf(splitText) ?? undefined);
    if (noteEvents && splitText.trim() !== '' && splitPointValue === undefined) {
      actionError = `${JSON.stringify(splitText.trim())} is not a pitch for the hand split — try 60 or C4.`;
      importing = false;
      return;
    }
    importNote = musicXml
      ? 'Reading the MusicXML file…'
      : noteEvents
      ? files.length === 1 ? 'Reading the NoteEvents file…' : `Reading ${files.length} NoteEvents stems…`
      : `Recognising ${files.length === 1 ? 'the page' : `${files.length} pages`}… this can take a minute.`;
    try {
      let job: ImportJobView = musicXml
        ? await submitMusicXml(files[0]!)
        : noteEvents
          ? await submitNoteEvents(files, splitPointValue)
          : await submitImport(files);
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
      if (musicXml && job.scoreId !== null && job.diagnostic !== null && job.diagnostic !== '') {
        // Lossy: say what was dropped before the person is taken into a chart that looks complete.
        importReport = { scoreId: job.scoreId, lines: job.diagnostic.split('\n') };
        return;
      }
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

  // New chart (SIB2-270). The form is closed until asked for, except in an empty library where it is the way in.
  let creating = $state(false);
  let creatingBusy = $state(false);
  let draftTitle = $state('');
  let draftKey = $state('C');
  let draftTime = $state('4/4');
  let draftBars = $state(32);
  let draftPickup = $state(false);
  let draftInstruments = $state<string[]>([]);
  let createError = $state<string | null>(null);

  async function makeChart(operations: Parameters<typeof createScore>[0]): Promise<void> {
    creatingBusy = true;
    createError = null;
    try {
      open(await createScore(operations));
    } catch (error) {
      createError = messageFor(error, 'create the chart');
    } finally {
      creatingBusy = false;
    }
  }

  function submitNewChart(event: SubmitEvent): void {
    event.preventDefault();
    const form = { title: draftTitle, key: draftKey, time: draftTime, bars: Number(draftBars), pickup: draftPickup, instruments: draftInstruments };
    const problem = problemWith(form);
    if (problem !== null) {
      createError = problem;
      return;
    }
    void makeChart(newChartOps(form, chartId(draftTitle)));
  }

  function openSample(): void {
    void makeChart(sampleChartOps(chartId('sample blues')));
  }

  function messageFor(error: unknown, verb: string): string {
    if (error instanceof OfflineError) return `Could not ${verb}: the server did not answer.`;
    if (error instanceof ApiError) return error.message;
    return error instanceof Error ? error.message : String(error);
  }

  void load();
</script>


{#snippet newChartForm()}
  <form class="new-chart" aria-label="New chart" onsubmit={submitNewChart}>
    <label class="nc-field nc-title"><span>Title</span><input type="text" bind:value={draftTitle} placeholder={UNTITLED} autocomplete="off" /></label>
    <label class="nc-field"><span>Key</span>
      <select bind:value={draftKey}>{#each KEY_CHOICES as choice (choice)}<option value={choice}>{choice}</option>{/each}</select>
    </label>
    <label class="nc-field"><span>Time</span>
      <select bind:value={draftTime}>{#each TIME_CHOICES as choice (choice)}<option value={choice}>{choice}</option>{/each}</select>
    </label>
    <label class="nc-field"><span>Bars</span><input type="number" min={MIN_BARS} max={MAX_BARS} bind:value={draftBars} /></label>
    <label class="nc-check"><input type="checkbox" bind:checked={draftPickup} /><span>Pickup bar</span></label>
    <InstrumentPicker value={draftInstruments} onchange={(next) => (draftInstruments = next)} disabled={creatingBusy} />
    <button class="import-btn primary" type="submit" disabled={creatingBusy}>{creatingBusy ? 'Creating…' : 'Create chart'}</button>
    {#if createError !== null}<div class="action-error nc-error" role="alert">{createError}</div>{/if}
  </form>
  <p class="nc-alt">
    or <button class="linklike" type="button" onclick={openSample} disabled={creatingBusy}>open a sample chart</button>
    (a twelve-bar blues you can edit and delete).{#if charts !== null && charts.length === 0}
      In a terminal: <code>{NEW_CHART_COMMAND}</code>{/if}
  </p>
{/snippet}

<section class="library">
  <!-- One hidden picker, driven by every Import button below. `accept` hints images and a NoteEvents .json (ADR-0040); the server is
       the real judge and decodes the bytes to validate them (ADR-0029). `multiple` is Q26. -->
  <input
    class="file-picker"
    type="file"
    accept={photoImport ? 'image/png,image/jpeg,application/json,.json,.musicxml,.xml,.mxl' : 'application/json,.json,.musicxml,.xml,.mxl'}
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
        <button class="import-btn primary" onclick={() => (creating = !creating)} aria-expanded={creating}>New chart</button>
        <button class="import-btn" onclick={() => fileInput?.click()} disabled={importing}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
            <path d="M8 10.5V2.5M5 5.5 8 2.5l3 3M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10" />
          </svg>
          {importing ? 'Importing…' : photoImport ? 'Import a photo' : 'Import a file'}
        </button>
        <label class="split-label" title="Where a piano file's hands pivot: a MIDI number or a pitch. Blank is middle C.">
          <span>Piano split</span>
          <input
            class="split-input"
            aria-label="Hand split for a piano file"
            placeholder="C4"
            title="Where a piano file's hands pivot: a MIDI number or a pitch. Blank is middle C."
            bind:value={splitText}
          />
        </label>
        <a class="import-btn" href={hashOf(AUDIO)}>Transcribe audio</a>
      {/if}
    </div>
  </div>

  {#if creating && !(charts !== null && charts.length === 0 && failure === null)}
    {@render newChartForm()}
  {/if}

  {#if importNote !== ''}
    <div class="import-note" role="status">
      <span class="spinner" aria-hidden="true"></span>{importNote}
    </div>
  {/if}

  {#if importReport !== null}
    <div class="import-note import-report" role="status">
      <div>
        <strong>Imported from MusicXML, with some parts left out:</strong>
        <ul>
          {#each importReport.lines as line (line)}<li>{line}</li>{/each}
        </ul>
        <button class="import-btn" onclick={() => importReport !== null && open(importReport.scoreId)}>Open the draft</button>
        <button class="import-btn" onclick={() => (importReport = null)}>Dismiss</button>
      </div>
    </div>
  {/if}

  {#if !photoImport && failure === null}
    <div class="import-note" role="note">Photo import is not available on this service yet. You can still transcribe audio or import a NoteEvents .json or MusicXML file.</div>
  {/if}

  {#if failure !== null}
    <!-- Not a state the mockup has: it only ever drew a running server. The distinction it
         cannot draw is the one a reader most needs — an empty library and an unreachable one
         look identical, and only one of them is fixed by typing a command. -->
    <div class="state">
      <h2>
        {failure === 'offline'
          ? 'No answer from the server.'
          : failure === 'signed-out'
            ? 'You have been signed out.'
            : 'The server refused that.'}
      </h2>
      <p>
        {#if failure === 'signed-out'}
          Sign in again to see your charts. <a href={SIGN_IN_PATH} onclick={rememberHere}>Sign in with GitHub</a>
        {:else if failure === 'offline'}
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
      <p>Start one here, or bring one in{photoImport ? ' from a photo or scan (every parse is a draft you correct, ADR-0019)' : ''}. A chart made in the browser or the terminal opens in both.</p>
      {@render newChartForm()}
      <button class="import-btn big" onclick={() => fileInput?.click()} disabled={importing}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
          <path d="M8 10.5V2.5M5 5.5 8 2.5l3 3M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10" />
        </svg>
        {importing ? 'Importing…' : photoImport ? 'Import a photo' : 'Import a file'}
      </button>
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
      <label class="sort">
        <span>Sort</span>
        <select aria-label="Sort charts" value={sort} onchange={(event) => chooseSort(event.currentTarget.value === 'title' ? 'title' : 'recent')}>
          <option value="recent">Recently edited</option>
          <option value="title">Title</option>
        </select>
      </label>
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
                <span><em>{UNTITLED}</em></span>
                <span class="row-id" title={chart.id}>{displayId(chart.id)}</span>
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
    flex-wrap: wrap;
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
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 14px;
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
  .split-input {
    width: 84px;
    background: var(--panel-2);
    border: 1px solid var(--rule);
    border-radius: 3px;
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink-soft);
    padding: 6px 8px;
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

  .import-btn.primary {
    color: var(--accent);
    border-color: var(--accent);
  }
  .split-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-soft);
  }
  .new-chart {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 12px 14px;
    margin-top: 16px;
    padding: 14px;
    background: var(--panel-2);
    border: 1px solid var(--rule);
    text-align: left;
  }
  .nc-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-soft);
  }
  .nc-field input,
  .nc-field select {
    font: inherit;
    font-size: 13px;
    letter-spacing: 0;
    text-transform: none;
    color: var(--ink);
    background: var(--panel);
    border: 1px solid var(--rule);
    border-radius: 3px;
    padding: 6px 8px;
    min-height: 32px;
  }
  .nc-title {
    flex: 1 1 200px;
  }
  .nc-field input[type='number'] {
    width: 72px;
  }
  .nc-check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--ink-soft);
    min-height: 32px;
  }
  .nc-error {
    flex-basis: 100%;
    margin: 0;
  }
  .nc-alt {
    margin: 8px 0 18px;
    font-size: 13px;
    color: var(--ink-soft);
    text-align: left;
  }
  .linklike {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: var(--accent);
    text-decoration: underline;
    cursor: pointer;
  }
  .linklike:disabled {
    opacity: 0.55;
    cursor: default;
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
  .import-report ul {
    margin: 6px 0 10px;
    padding-left: 18px;
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

  .sort {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .sort select {
    font: inherit;
    letter-spacing: 0;
    text-transform: none;
    font-size: 12px;
    color: var(--ink-soft);
    background: var(--panel-2);
    border: 1px solid var(--rule);
    border-radius: 3px;
    padding: 3px 6px;
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
