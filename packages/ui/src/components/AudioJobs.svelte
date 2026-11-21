<script lang="ts">
  /**
   * Audio to be transcribed (SIB2-137): the browser's half of Q79 parity for `sbscore audio`.
   *
   * Upload a recording, watch its job move queued, running, succeeded or failed, retry a failed one, delete
   * any. The transcription itself runs on a separate worker that pulls jobs (ADR-0034, decision 14), so a
   * job may wait a while, and this page works whether or not any worker is running — it says so rather
   * than spinning. The list is polled while anything is still moving.
   *
   * Material 3, tokens only (`m3.css`).
   */
  import { onMount } from 'svelte';
  import { deleteAudio, listAudioJobs, retryAudio, submitAudio } from '../lib/api.js';
  import type { AudioJobView } from '../lib/api.js';
  import { relativeTime } from '../lib/format.js';
  import { hashOf, LIBRARY } from '../lib/routing.js';

  const POLL_MS = 3000;
  const WORDS: Record<AudioJobView['status'], string> = {
    'awaiting-upload': 'Waiting for the upload',
    queued: 'Queued, waiting for a transcription worker',
    running: 'Transcribing',
    succeeded: 'Done',
    failed: 'Failed',
  };

  let jobs = $state<AudioJobView[] | null>(null);
  let failure = $state<string | null>(null);
  let uploading = $state(false);
  let instrument = $state('');
  let picker = $state<HTMLInputElement | undefined>(undefined);
  let confirming = $state<string | null>(null);

  const active = (list: AudioJobView[] | null): boolean =>
    list !== null && list.some((j) => j.status === 'queued' || j.status === 'running' || j.status === 'awaiting-upload');

  async function load(): Promise<void> {
    try {
      jobs = await listAudioJobs();
      failure = null;
    } catch {
      failure = 'Could not load your audio jobs. Check the server is reachable and try again.';
    }
  }

  onMount(() => {
    void load();
    const timer = setInterval(() => {
      if (active(jobs)) void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  });

  async function chosen(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file === undefined) return;
    uploading = true;
    failure = null;
    try {
      await submitAudio(file, instrument.trim() === '' ? null : instrument.trim().toLowerCase());
      await load();
    } catch (error) {
      failure = error instanceof Error ? error.message : 'The upload failed.';
    } finally {
      uploading = false;
    }
  }

  async function retry(id: string): Promise<void> {
    try {
      await retryAudio(id);
    } catch (error) {
      failure = error instanceof Error ? error.message : 'Could not retry that job.';
    }
    await load();
  }

  async function remove(id: string): Promise<void> {
    confirming = null;
    try {
      await deleteAudio(id);
    } catch {
      // gone already: the re-read shows what is true
    }
    await load();
  }
</script>

<section class="page" aria-labelledby="audio-title">
  <div class="sheet">
    <div class="head">
      <h1 id="audio-title">Audio</h1>
      <a class="text" href={hashOf(LIBRARY)}>Back to the library</a>
    </div>

    <p class="quiet">
      Upload a recording and a transcription worker turns it into notes you can edit. The same thing from a
      terminal: <span class="cmd">sbscore audio submit take.wav</span>
    </p>

    <div class="upload">
      <label>
        <span>Instrument (optional)</span>
        <input type="text" bind:value={instrument} placeholder="piano" maxlength="32" />
      </label>
      <input
        bind:this={picker}
        class="hidden"
        type="file"
        accept="audio/*"
        onchange={chosen}
        data-testid="audio-file"
      />
      <button class="filled" type="button" disabled={uploading} onclick={() => picker?.click()}>
        {uploading ? 'Uploading' : 'Choose audio'}
      </button>
    </div>

    {#if failure !== null}
      <div class="banner" role="alert">{failure}</div>
    {/if}

    {#if jobs === null && failure === null}
      <p class="quiet" role="status">Loading your audio jobs</p>
    {:else if jobs !== null && jobs.length === 0}
      <p class="quiet">No audio jobs yet.</p>
    {:else if jobs !== null}
      <ul class="rows">
        {#each jobs as job (job.id)}
          <li class="row">
            <span class="name">{job.filename ?? job.id}</span>
            <div class="meta">
              <span class="state" data-status={job.status}>{WORDS[job.status]}</span>
              {#if job.progress !== null}
                <span>{Math.round(job.progress.fraction * 100)}%, {job.progress.stage}</span>
              {/if}
              {#if job.status === 'failed' && job.diagnostic !== null}<span>{job.diagnostic}</span>{/if}
              <span>{relativeTime(job.updatedAt)}</span>
            </div>
            <div class="act">
              {#if job.scoreId !== null}
                <a class="text" href={`#/score/${encodeURIComponent(job.scoreId)}`}>Open the chart</a>
              {/if}
              {#if job.status === 'failed'}
                <button class="text" type="button" onclick={() => retry(job.id)}>Retry</button>
              {/if}
              {#if confirming === job.id}
                <button class="text" type="button" onclick={() => (confirming = null)}>Keep</button>
                <button class="danger" type="button" onclick={() => remove(job.id)}>Delete</button>
              {:else}
                <button class="danger" type="button" aria-label={`Delete ${job.filename ?? job.id}`} onclick={() => (confirming = job.id)}>Delete</button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>

<style>
  .page {
    display: grid;
    justify-items: center;
    padding: 48px 16px;
  }
  .sheet {
    width: min(640px, 100%);
    display: flex;
    flex-direction: column;
    gap: 20px;
    color: var(--md-sys-color-on-surface);
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  h1 {
    margin: 0;
    font: var(--md-sys-typescale-headline-small);
  }
  .quiet {
    margin: 0;
    font: var(--md-sys-typescale-body-medium);
    color: var(--md-sys-color-on-surface-variant);
  }
  .cmd {
    padding: 2px 8px;
    border-radius: var(--md-sys-shape-corner-small);
    background: var(--md-sys-color-surface-container-high);
    color: var(--md-sys-color-on-surface);
  }
  .upload {
    display: flex;
    align-items: end;
    gap: 16px;
    flex-wrap: wrap;
  }
  label {
    display: grid;
    gap: 4px;
    font: var(--md-sys-typescale-label-medium);
    color: var(--md-sys-color-on-surface-variant);
  }
  input[type='text'] {
    padding: 8px 12px;
    border: 1px solid var(--md-sys-color-outline);
    border-radius: var(--md-sys-shape-corner-small);
    background: var(--md-sys-color-surface);
    color: var(--md-sys-color-on-surface);
    font: var(--md-sys-typescale-body-medium);
  }
  .hidden {
    display: none;
  }
  button,
  a.text {
    font: var(--md-sys-typescale-label-large);
    cursor: pointer;
  }
  button.filled {
    padding: 10px 20px;
    border: 0;
    border-radius: var(--md-sys-shape-corner-full);
    background: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-primary);
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  button.text,
  a.text {
    padding: 6px 12px;
    border: 0;
    background: none;
    color: var(--md-sys-color-primary);
    text-decoration: none;
  }
  button.danger {
    padding: 6px 12px;
    border: 0;
    background: none;
    color: var(--md-sys-color-error);
  }
  .banner {
    padding: 12px 16px;
    border-radius: var(--md-sys-shape-corner-medium);
    background: var(--md-sys-color-error-container);
    color: var(--md-sys-color-on-error-container);
    font: var(--md-sys-typescale-body-medium);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    background: var(--md-sys-color-surface-container-low);
    border-radius: var(--md-sys-shape-corner-medium);
    box-shadow: var(--md-sys-elevation-level1);
    overflow: hidden;
  }
  .row {
    display: grid;
    gap: 6px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
  }
  .row:last-child {
    border-bottom: 0;
  }
  .name {
    font: var(--md-sys-typescale-title-medium);
    overflow-wrap: anywhere;
  }
  .meta {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    font: var(--md-sys-typescale-body-small);
    color: var(--md-sys-color-on-surface-variant);
  }
  .state[data-status='failed'] {
    color: var(--md-sys-color-error);
  }
  .act {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    justify-content: end;
  }
</style>
