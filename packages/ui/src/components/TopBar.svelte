<script lang="ts">
  /**
   * The one persistent piece of chrome: the mark, where you are, and which server you are
   * talking to.
   *
   * The host readout is not decoration. Everything on screen came from a local process the
   * reader started themselves (ADR-0001), and the difference between "the library is empty" and
   * "the server is not running" is the first thing anyone asks — so the address is always
   * visible and the dot answers it.
   */
  import type { Snippet } from 'svelte';
  import { UNTITLED } from '@sibei/model';
  import type { Route } from '../lib/routing.js';

  interface Props {
    route: Route;
    /** The open chart's title. `''` is a real, untitled chart; `null` is no chart open. */
    title: string | null;
    /** Whether the last request to the API came back. Not polled — this slice has no live wire. */
    reachable: boolean;
    onLibrary: () => void;
    /** The account chip, on a hosted deployment (V20b). Absent on a local install, which has no accounts. */
    account?: Snippet;
  }

  const { route, title, reachable, onLibrary, account }: Props = $props();

  const label = __API_LABEL__;
  // Anything but the library is somewhere to come back from: a chart, the device approval, the token list.
  const onScore = $derived(route.view !== 'library');
</script>

<header class="top">
  <div class="mark">sibei<span>·</span>score</div>
  <nav class="crumbs" aria-label="Breadcrumb">
    {#if onScore}
      <button class="crumb-btn" onclick={onLibrary}>Library</button>
      <span class="crumb-sep">/</span>
      <span class="crumb-now" class:untitled={title === ''} class:page={route.view !== 'score'}>
        {#if title === null}…{:else if title === ''}<em>{UNTITLED}</em>{:else}{title}{/if}
      </span>
    {/if}
  </nav>
  <div class="host" title={reachable ? `connected to ${label}` : `no answer from ${label}`}>
    <span class="dot" class:down={!reachable} aria-hidden="true"></span><span class="address">{label}</span>
  </div>
  {@render account?.()}
</header>

<style>
  .top {
    position: sticky;
    top: 0;
    z-index: 20;
    height: var(--top-h);
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 18px;
    background: var(--panel);
    border-bottom: 1px solid var(--rule);
  }

  .mark {
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--ink);
    font-weight: 600;
  }
  .mark span {
    color: var(--accent);
  }

  .crumbs {
    display: flex;
    align-items: baseline;
    gap: 9px;
    min-width: 0;
    flex: 1;
  }

  .crumb-btn {
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .crumb-btn:hover {
    color: var(--accent);
  }
  .crumb-sep {
    color: var(--ink-faint);
  }
  .crumb-now {
    font-family: var(--serif);
    font-size: 16px;
    text-transform: none;
    letter-spacing: 0;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .crumb-now.untitled {
    font-style: italic;
    color: var(--ink-faint);
  }
  /* The serif is a chart's own title. A page that is not a chart (device approval, API tokens) names itself
     in the account chrome's one typeface, so the bar and the page beneath it do not speak in two voices. */
  .crumb-now.page {
    font: var(--md-sys-typescale-title-medium);
  }

  .host {
    font-size: 11px;
    color: var(--ink-faint);
    letter-spacing: 0.05em;
    display: flex;
    align-items: center;
    gap: 7px;
    white-space: nowrap;
  }
  /* On a phone the bar has room for the dot or for where you are, not both: with an account chip beside it,
     the address pushed the page's name out of view. The dot stays (it still says whether the server
     answers), and the address remains in its tooltip. */
  @media (max-width: 560px) {
    .address {
      display: none;
    }
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--live);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--live) 20%, transparent);
  }
  /* Not in the mockup, which only ever drew a running server. The real one can be stopped, and
     a green dot over a dead socket would be the same class of lie as a silent export fallback. */
  .dot.down {
    background: var(--ink-faint);
    box-shadow: none;
  }
</style>
