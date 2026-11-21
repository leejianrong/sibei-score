<script lang="ts">
  /**
   * Consent for an MCP client (V22a): the step in the OAuth flow where a signed-in person says yes or no.
   *
   * An agent that was given this server's `/mcp` address registered itself and sent the browser here
   * (`#/authorize?…`, by the server's authorise endpoint). The person sees who is asking, what it would be
   * able to do, and where the browser goes next, and chooses. Approving mints nothing in this page: the
   * server answers where to send the browser, with a code the client exchanges for its own token, so **no
   * token or code is ever drawn or kept here**. The page just navigates.
   *
   * Material 3, tokens only (`m3.css`), in one typeface throughout.
   */
  import { decideAuthorization, getMe } from '../lib/api.js';
  import { consentFailure, describeRequest } from '../lib/consent.js';
  import { hashOf, LIBRARY } from '../lib/routing.js';

  let { params }: { params: Record<string, string> } = $props();

  // The server's list of known client hosts. It comes from `GET /v1/me`, never from the link: the link is built
  // by whoever registered the client. Until it arrives, or if it cannot be had, every host reads as unknown.
  let knownHosts = $state<string[]>([]);
  let listed = $state(false);
  void getMe()
    .then((me) => (knownHosts = me.mcpKnownHosts ?? []))
    .catch(() => {})
    .finally(() => (listed = true));

  const view = $derived(describeRequest(params, knownHosts));
  let sending = $state(false);
  let failure = $state<string | null>(null);

  async function decide(approve: boolean): Promise<void> {
    if (sending) return;
    sending = true;
    failure = null;
    try {
      // A full navigation: the destination is the client's own redirect URI, which may be another origin
      // or a private-use scheme for a desktop app.
      window.location.assign(await decideAuthorization(params, approve));
    } catch (error) {
      failure = consentFailure(error);
      sending = false;
    }
  }
</script>

<section class="page" aria-labelledby="consent-title">
  <div class="card">
    {#if view === null}
      <h1 id="consent-title">Nothing to approve</h1>
      <p class="lede">This page is opened by an app asking to connect to your charts. Start from the app.</p>
      <div class="actions">
        <button class="filled" type="button" onclick={() => (window.location.hash = hashOf(LIBRARY))}>Back to the library</button>
      </div>
    {:else}
      <h1 id="consent-title">Send access to <span class="origin">{view.origin}</span>?</h1>
      <p class="lede">
        An app that calls itself <strong>{view.clientName}</strong> (a name it chose; we cannot verify it) is asking to
        use your sibei-score charts through MCP. After you approve, it receives access at that address. Only approve
        an app you just opened yourself.
      </p>
      {#if listed && !view.known}
        <div class="banner warn" role="alert">
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" /></svg>
          <div>
            <strong>We do not recognise {view.destination}.</strong> Anyone can register an app under any name, and
            this address is not one of the clients this server knows. Approve only if you started this from a tool you
            trust, and you can tell where it sends you.
          </div>
        </div>
      {/if}

      {#if failure !== null}
        <div class="banner bad" role="alert">
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M11 7h2v6h-2zm0 8h2v2h-2zM12 2a10 10 0 100 20 10 10 0 000-20z" /></svg>
          <div>{failure}</div>
        </div>
      {/if}

      <div class="block">
        <h2>It will be able to</h2>
        <ul>
          {#each view.grants as grant (grant)}<li>{grant}</li>{/each}
        </ul>
      </div>
      <p class="help">
        After you choose, this page sends you to <code>{view.destination}</code>. Access lasts 30 days and you can
        revoke it any time under API tokens.
      </p>

      <div class="actions">
        <button class="text" type="button" disabled={sending} onclick={() => decide(false)}>Deny</button>
        <button class="filled" type="button" disabled={sending || !listed} onclick={() => decide(true)}>{sending ? 'Working' : 'Approve'}</button>
      </div>
    {/if}
  </div>
</section>

<style>
  .page {
    display: grid;
    justify-items: center;
    padding: 48px 16px;
  }
  .card {
    width: min(560px, 100%);
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 24px;
    background: var(--md-sys-color-surface-container-low);
    color: var(--md-sys-color-on-surface);
    border-radius: var(--md-sys-shape-corner-medium);
    box-shadow: var(--md-sys-elevation-level1);
  }
  h1 {
    margin: 0;
    font: var(--md-sys-typescale-headline-small);
    text-wrap: balance;
  }
  h2 {
    margin: 0 0 6px;
    font: var(--md-sys-typescale-label-medium);
    color: var(--md-sys-color-on-surface-variant);
  }
  .lede {
    margin: 0;
    font: var(--md-sys-typescale-body-medium);
    color: var(--md-sys-color-on-surface-variant);
  }
  ul {
    margin: 0;
    padding-left: 20px;
    font: var(--md-sys-typescale-body-large);
  }
  .help {
    margin: 0;
    font: var(--md-sys-typescale-body-small);
    color: var(--md-sys-color-on-surface-variant);
  }
  code {
    font: inherit;
    font-weight: 600;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .filled,
  .text {
    position: relative;
    isolation: isolate;
    height: 40px;
    border: 0;
    border-radius: var(--md-sys-shape-corner-full);
    font: var(--md-sys-typescale-label-large);
    letter-spacing: var(--md-sys-typescale-label-large-tracking);
    cursor: pointer;
    outline: none;
  }
  .filled {
    padding: 0 24px;
    background: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-primary);
  }
  .text {
    padding: 0 12px;
    background: none;
    color: var(--md-sys-color-primary);
  }
  .filled:disabled,
  .text:disabled {
    cursor: not-allowed;
    opacity: 0.38;
  }
  .filled::before,
  .text::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background: currentColor;
    opacity: 0;
    transition: opacity var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard);
  }
  .filled:hover:not(:disabled)::before,
  .text:hover:not(:disabled)::before {
    opacity: var(--md-sys-state-hover-opacity);
  }
  .filled:focus-visible::before,
  .text:focus-visible::before {
    opacity: var(--md-sys-state-focus-opacity);
  }
  .filled:active:not(:disabled)::before,
  .text:active:not(:disabled)::before {
    opacity: var(--md-sys-state-pressed-opacity);
  }
  .filled:focus-visible,
  .text:focus-visible {
    outline: 2px solid var(--md-sys-color-primary);
    outline-offset: 2px;
  }
  .banner {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 12px 16px;
    border-radius: var(--md-sys-shape-corner-medium);
    font: var(--md-sys-typescale-body-medium);
  }
  .banner svg {
    flex: none;
  }
  .banner.warn {
    background: var(--md-sys-color-secondary-container);
    color: var(--md-sys-color-on-secondary-container);
  }
  .origin {
    overflow-wrap: anywhere;
  }
  .banner.bad {
    background: var(--md-sys-color-error-container);
    color: var(--md-sys-color-on-error-container);
  }
  @media (max-width: 560px) {
    .card {
      padding: 20px 16px;
    }
  }
</style>
