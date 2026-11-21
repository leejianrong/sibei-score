<script lang="ts">
  /**
   * The account page (V25): what this service keeps, and the one irreversible thing you can do about it,
   * delete the account (ADR-0034 decisions 11 and 16).
   *
   * Deletion is a hard delete with no grace period, so the button stays disabled until the person has typed
   * their own login back: the page makes them read what is about to happen, and the server checks it again.
   * It asks the server with the session cookie only (a token cannot do this), which is also why there is no
   * CLI verb for it. On success the session is gone and the app shows the sign-in gate.
   *
   * Material 3, tokens only (`m3.css`), in one typeface throughout.
   */
  import { deleteAccount } from '../lib/api.js';
  import { displayName } from '../lib/session.js';
  import type { Account } from '../lib/session.js';

  interface Props {
    account: Account;
    onDeleted: () => void;
  }

  const { account, onDeleted }: Props = $props();

  let typed = $state('');
  let working = $state(false);
  let failure = $state<string | null>(null);

  const matches = $derived(typed.trim().toLowerCase() === account.login.toLowerCase());

  async function remove(): Promise<void> {
    if (!matches || working) return;
    working = true;
    failure = null;
    try {
      await deleteAccount(typed.trim());
      onDeleted();
    } catch {
      failure = 'Could not delete the account. Nothing was lost if this message is showing; try again.';
    } finally {
      working = false;
    }
  }
</script>

<section class="page" aria-labelledby="account-title">
  <div class="sheet">
    <h1 id="account-title">Account</h1>

    <div class="card">
      <h2>{displayName(account)}</h2>
      <p>Signed in with GitHub as <strong>@{account.login}</strong>. Your charts, scans and tokens belong to this account alone.</p>
      <p>
        This is a beta. Data can be wiped while it is in progress, so export a chart as PDF or MusicXML to
        keep a copy you control.
      </p>
    </div>

    <div class="card danger-zone">
      <h2>Delete account</h2>
      <p>
        This permanently deletes every chart and its edit history, every import and its scans, your API
        tokens and your sign-in. There is no grace period and it cannot be undone.
      </p>
      <label class="field">
        <span>Type <strong>{account.login}</strong> to confirm</span>
        <input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" bind:value={typed} />
      </label>
      {#if failure !== null}<p class="bad" role="alert">{failure}</p>{/if}
      <div class="act">
        <button class="danger-filled" type="button" disabled={!matches || working} onclick={remove}>
          {working ? 'Deleting' : 'Delete my account'}
        </button>
      </div>
    </div>
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
  h1 {
    margin: 0;
    font: var(--md-sys-typescale-headline-small);
  }
  h2 {
    margin: 0;
    font: var(--md-sys-typescale-title-large);
  }
  .card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    padding: 24px;
    background: var(--md-sys-color-surface-container-low);
    border-radius: var(--md-sys-shape-corner-medium);
    box-shadow: var(--md-sys-elevation-level1);
  }
  .card p {
    margin: 0;
    font: var(--md-sys-typescale-body-medium);
    color: var(--md-sys-color-on-surface-variant);
  }
  .danger-zone {
    box-shadow: inset 0 0 0 1px var(--md-sys-color-error);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    font: var(--md-sys-typescale-body-medium);
  }
  .field input {
    height: 48px;
    padding: 0 16px;
    border: 1px solid var(--md-sys-color-outline);
    border-radius: var(--md-sys-shape-corner-extra-small);
    background: var(--md-sys-color-surface);
    color: var(--md-sys-color-on-surface);
    font: var(--md-sys-typescale-body-large);
  }
  .field input:focus-visible {
    outline: 2px solid var(--md-sys-color-primary);
    outline-offset: 1px;
  }
  .bad {
    color: var(--md-sys-color-error);
  }
  .danger-filled {
    position: relative;
    isolation: isolate;
    display: inline-flex;
    align-items: center;
    height: 40px;
    padding: 0 20px;
    border: 0;
    border-radius: var(--md-sys-shape-corner-full);
    background: var(--md-sys-color-error);
    color: var(--md-sys-color-on-error);
    font: var(--md-sys-typescale-label-large);
    letter-spacing: var(--md-sys-typescale-label-large-tracking);
    cursor: pointer;
    outline: none;
  }
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
  .danger-filled:hover:not(:disabled)::before {
    opacity: var(--md-sys-state-hover-opacity);
  }
  .danger-filled:focus-visible::before {
    opacity: var(--md-sys-state-focus-opacity);
  }
  .danger-filled:active:not(:disabled)::before {
    opacity: var(--md-sys-state-pressed-opacity);
  }
  .danger-filled:focus-visible {
    outline: 2px solid var(--md-sys-color-primary);
    outline-offset: 2px;
  }
  .danger-filled:disabled {
    opacity: 0.38;
    cursor: not-allowed;
  }
</style>
