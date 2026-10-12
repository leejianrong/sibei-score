<script lang="ts">
  /**
   * The caller's API tokens (V21b), to recognise and revoke: the UI control for `sbscore auth`, as Q79 asks
   * of every capability.
   *
   * A row carries what a person needs to tell tokens apart (name, scopes, created, expires) and never the
   * token, which the server does not keep. Revoking takes effect at once and cannot be undone, so it asks
   * first, in the row, rather than in a dialog the page would have to stand up and focus-trap.
   *
   * Material 3, tokens only (`m3.css`), in one typeface throughout.
   */
  import { onMount } from 'svelte';
  import { listApiTokens, revokeApiToken } from '../lib/api.js';
  import type { ApiTokenView } from '../lib/api.js';
  import { formatDay } from '../lib/devices.js';
  import { DEVICE, hashOf } from '../lib/routing.js';

  let tokens = $state<ApiTokenView[] | null>(null);
  let failure = $state<string | null>(null);
  let confirming = $state<string | null>(null);
  let revoking = $state<string | null>(null);

  async function load(): Promise<void> {
    failure = null;
    try {
      tokens = await listApiTokens();
    } catch {
      tokens = null;
      failure = 'Could not load your API tokens. Check the server is reachable and try again.';
    }
  }

  onMount(() => void load());

  async function revoke(id: string): Promise<void> {
    revoking = id;
    try {
      await revokeApiToken(id);
      tokens = (tokens ?? []).filter((t) => t.id !== id);
      confirming = null;
    } catch {
      // Gone already, or not reachable: re-read so the page shows what is true rather than what it hoped.
      confirming = null;
      await load();
    } finally {
      revoking = null;
    }
  }

  const command = `sbscore --url ${window.location.origin} auth login`;
</script>

<section class="page" aria-labelledby="tokens-title">
  <div class="sheet">
    <div class="head">
      <h1 id="tokens-title">API tokens</h1>
      <a class="text" href={hashOf(DEVICE)}>Approve a device</a>
    </div>

    {#if failure !== null}
      <div class="banner bad" role="alert">
        <div>{failure}</div>
        <button class="text" type="button" onclick={load}>Try again</button>
      </div>
    {:else if tokens === null}
      <p class="quiet" role="status">Loading your tokens</p>
    {:else if tokens.length === 0}
      <div class="empty">
        <h2>No API tokens yet</h2>
        <p>A token lets the command line or an agent work in your library without your password. Create one from a terminal:</p>
        <span class="cmd">{command}</span>
      </div>
    {:else}
      <ul class="rows">
        {#each tokens as token (token.id)}
          <li class="row" class:confirm={confirming === token.id}>
            <span class="name">{token.name}</span>
            <div class="meta">
              {#each token.scopes as scope (scope)}<span class="scope">{scope}</span>{/each}
              {#if confirming === token.id}
                <span>Revoking stops it working immediately.</span>
              {:else}
                <span>Created {formatDay(token.createdAt)}</span>
                <span>Expires {formatDay(token.expiresAt)}</span>
              {/if}
            </div>
            <div class="act">
              {#if confirming === token.id}
                <button class="text keep" type="button" onclick={() => (confirming = null)}>Keep</button>
                <button class="danger-filled" type="button" disabled={revoking === token.id} onclick={() => revoke(token.id)}>
                  {revoking === token.id ? 'Revoking' : 'Revoke'}
                </button>
              {:else}
                <button class="danger" type="button" aria-label={`Revoke ${token.name}`} onclick={() => (confirming = token.id)}>Revoke</button>
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
  h2 {
    margin: 0;
    font: var(--md-sys-typescale-title-large);
  }
  .quiet {
    margin: 0;
    font: var(--md-sys-typescale-body-medium);
    color: var(--md-sys-color-on-surface-variant);
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
    grid-template-columns: 1fr auto;
    gap: 4px 16px;
    align-items: center;
    padding: 16px 20px;
    border-top: 1px solid var(--md-sys-color-outline-variant);
  }
  .row:first-child {
    border-top: 0;
  }
  .row.confirm {
    background: var(--md-sys-color-error-container);
    color: var(--md-sys-color-on-error-container);
  }
  .name {
    font: var(--md-sys-typescale-title-medium);
    overflow-wrap: anywhere;
  }
  .meta {
    grid-column: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
    font: var(--md-sys-typescale-body-small);
    color: var(--md-sys-color-on-surface-variant);
  }
  .row.confirm .meta {
    color: inherit;
  }
  .scope {
    display: inline-flex;
    align-items: center;
    height: 20px;
    padding: 0 8px;
    border-radius: var(--md-sys-shape-corner-extra-small);
    background: var(--md-sys-color-secondary-container);
    color: var(--md-sys-color-on-secondary-container);
    font: var(--md-sys-typescale-label-medium);
  }
  .row.confirm .scope {
    background: transparent;
    color: inherit;
    box-shadow: inset 0 0 0 1px currentColor;
  }
  .act {
    grid-column: 2;
    grid-row: 1 / span 2;
    display: flex;
    gap: 4px;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    padding: 40px 24px;
    background: var(--md-sys-color-surface-container-low);
    border-radius: var(--md-sys-shape-corner-medium);
    box-shadow: var(--md-sys-elevation-level1);
  }
  .empty p {
    margin: 0;
    font: var(--md-sys-typescale-body-medium);
    color: var(--md-sys-color-on-surface-variant);
  }
  .cmd {
    padding: 8px 12px;
    border-radius: var(--md-sys-shape-corner-extra-small);
    background: var(--md-sys-color-surface-container-high);
    font: var(--md-sys-typescale-label-large);
    overflow-wrap: anywhere;
  }

  .banner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 16px;
    padding: 12px 16px;
    border-radius: var(--md-sys-shape-corner-medium);
    font: var(--md-sys-typescale-body-medium);
  }
  .banner.bad {
    background: var(--md-sys-color-error-container);
    color: var(--md-sys-color-on-error-container);
  }

  /* Text-style buttons with a state layer; the destructive one uses the error role. */
  .text,
  .danger,
  .danger-filled {
    position: relative;
    isolation: isolate;
    display: inline-flex;
    align-items: center;
    height: 40px;
    padding: 0 12px;
    border: 0;
    border-radius: var(--md-sys-shape-corner-full);
    background: none;
    font: var(--md-sys-typescale-label-large);
    letter-spacing: var(--md-sys-typescale-label-large-tracking);
    text-decoration: none;
    cursor: pointer;
    outline: none;
  }
  .text {
    color: var(--md-sys-color-primary);
  }
  .text.keep {
    color: inherit;
  }
  .danger {
    color: var(--md-sys-color-error);
  }
  .danger-filled {
    padding: 0 20px;
    background: var(--md-sys-color-error);
    color: var(--md-sys-color-on-error);
  }
  .text::before,
  .danger::before,
  .danger-filled::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background: currentColor;
    opacity: 0;
    transition: opacity var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard);
  }
  .text:hover::before,
  .danger:hover::before,
  .danger-filled:hover:not(:disabled)::before {
    opacity: var(--md-sys-state-hover-opacity);
  }
  .text:focus-visible::before,
  .danger:focus-visible::before,
  .danger-filled:focus-visible::before {
    opacity: var(--md-sys-state-focus-opacity);
  }
  .text:active::before,
  .danger:active::before,
  .danger-filled:active:not(:disabled)::before {
    opacity: var(--md-sys-state-pressed-opacity);
  }
  .text:focus-visible,
  .danger:focus-visible,
  .danger-filled:focus-visible {
    outline: 2px solid var(--md-sys-color-primary);
    outline-offset: 2px;
  }
  .danger-filled:disabled {
    opacity: 0.6;
    cursor: progress;
  }

  @media (max-width: 560px) {
    .row {
      grid-template-columns: 1fr;
    }
    .act {
      grid-column: 1;
      grid-row: auto;
      justify-self: start;
    }
  }
</style>
