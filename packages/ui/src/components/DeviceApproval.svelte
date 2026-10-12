<script lang="ts">
  /**
   * Approve the code a CLI printed (V21b): the step in the device flow where a signed-in person says yes.
   *
   * `sbscore auth login` tells a person to open `#/device` and type the code. They name the device and
   * choose what its token may do, and the CLI, which is polling, collects a token the server minted. **No
   * token is ever shown here**: this page only says yes to a code, and the token goes to whoever holds the
   * device code.
   *
   * The code field shapes what is typed (`bcdfghjk` becomes `BCDF-GHJK`) and notices when it is plainly
   * short, but does not know which characters are valid; the server answers that, and says the same thing
   * for a code that never existed, one that expired and one already used.
   *
   * Material 3, tokens only (`m3.css`), in one typeface throughout.
   */
  import { approveDevice } from '../lib/api.js';
  import { formatTypedCode, isCompleteCode, outcomeOfFailure, SCOPE_CHOICES, toggleScope } from '../lib/devices.js';
  import type { Outcome, ScopeName } from '../lib/devices.js';
  import { hashOf, LIBRARY, TOKENS } from '../lib/routing.js';

  let code = $state('');
  let name = $state('sbscore CLI');
  let scopes = $state<ScopeName[]>(['read', 'write']);
  let sending = $state(false);
  let outcome = $state<Outcome | null>(null);
  let touched = $state(false);

  const complete = $derived(isCompleteCode(code));
  const shortCode = $derived(touched && code !== '' && !complete);

  function onCode(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    code = formatTypedCode(input.value);
    input.value = code;
    outcome = null;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    touched = true;
    if (!complete || sending) return;
    sending = true;
    outcome = null;
    try {
      await approveDevice({ userCode: code, name: name.trim() === '' ? 'sbscore CLI' : name.trim(), scopes });
      outcome = { kind: 'approved' };
    } catch (error) {
      const known = outcomeOfFailure(error);
      outcome = known ?? { kind: 'refused', message: 'Could not reach the server. Try again in a moment.' };
    } finally {
      sending = false;
    }
  }

  const go = (hash: string): void => void (window.location.hash = hash);
</script>

<section class="page" aria-labelledby="device-title">
  <div class="card">
    {#if outcome?.kind === 'approved'}
      <div class="banner ok" role="status">
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" /></svg>
        <div><strong>Device approved.</strong><br />Return to your terminal. This page can be closed.</div>
      </div>
      <div class="actions">
        <button class="text" type="button" onclick={() => go(hashOf(TOKENS))}>View API tokens</button>
        <button class="filled" type="button" onclick={() => go(hashOf(LIBRARY))}>Done</button>
      </div>
    {:else}
      <h1 id="device-title">Approve a device</h1>
      <p class="lede">Enter the code shown in your terminal. Only approve a code you started yourself.</p>

      {#if outcome?.kind === 'not-waiting'}
        <div class="banner bad" role="alert">
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M11 7h2v6h-2zm0 8h2v2h-2zM12 2a10 10 0 100 20 10 10 0 000-20z" /></svg>
          <div>
            <strong>That code is not waiting for approval.</strong><br />It may have expired. Run
            <code>sbscore auth login</code> again and enter the new code.
          </div>
        </div>
      {:else if outcome?.kind === 'refused'}
        <div class="banner bad" role="alert">
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M11 7h2v6h-2zm0 8h2v2h-2zM12 2a10 10 0 100 20 10 10 0 000-20z" /></svg>
          <div>{outcome.message}</div>
        </div>
      {/if}

      <form onsubmit={submit} novalidate>
        <div class="field">
          <label for="device-code">Code</label>
          <input
            id="device-code"
            class="code"
            class:invalid={shortCode || outcome?.kind === 'not-waiting'}
            type="text"
            inputmode="text"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            maxlength="9"
            placeholder="ABCD-EFGH"
            value={code}
            oninput={onCode}
            onblur={() => (touched = true)}
            aria-describedby="device-code-help"
            aria-invalid={shortCode || outcome?.kind === 'not-waiting'}
          />
          <span id="device-code-help" class="help" class:error={shortCode}>
            {shortCode ? 'A code is eight letters and digits.' : 'Eight letters and digits. Dashes and case do not matter.'}
          </span>
        </div>

        <div class="field">
          <label for="device-name">Name</label>
          <input id="device-name" class="text-input" type="text" maxlength="60" bind:value={name} aria-describedby="device-name-help" />
          <span id="device-name-help" class="help">So you can recognise it later in your API tokens.</span>
        </div>

        <fieldset class="field">
          <legend>Allow this device to</legend>
          <div class="chips">
            {#each SCOPE_CHOICES as choice (choice.scope)}
              <button
                class="filter"
                class:on={scopes.includes(choice.scope)}
                type="button"
                aria-pressed={scopes.includes(choice.scope)}
                onclick={() => (scopes = toggleScope(scopes, choice.scope))}
              >
                {#if scopes.includes(choice.scope)}<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" /></svg>{/if}
                {choice.label}
              </button>
            {/each}
          </div>
          <span class="help">The token expires after 90 days. You can revoke it any time.</span>
        </fieldset>

        <div class="actions">
          <button class="text" type="button" onclick={() => go(hashOf(LIBRARY))}>Cancel</button>
          <button class="filled" type="submit" disabled={sending || !complete}>{sending ? 'Approving' : 'Approve'}</button>
        </div>
      </form>
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
  .lede {
    margin: 0;
    font: var(--md-sys-typescale-body-medium);
    color: var(--md-sys-color-on-surface-variant);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }
  label,
  legend {
    padding: 0;
    font: var(--md-sys-typescale-label-medium);
    color: var(--md-sys-color-on-surface-variant);
  }
  /* A legend takes no part in the fieldset's flex gap, so it carries its own. */
  legend {
    margin-bottom: 6px;
  }
  .help {
    font: var(--md-sys-typescale-body-small);
    color: var(--md-sys-color-on-surface-variant);
  }
  .help.error {
    color: var(--md-sys-color-error);
  }

  /* Outlined text fields. The code is the same typeface as everything else, spaced and tabular. */
  input {
    height: 56px;
    padding: 0 16px;
    border: 1px solid var(--md-sys-color-outline);
    border-radius: var(--md-sys-shape-corner-extra-small);
    background: transparent;
    color: var(--md-sys-color-on-surface);
    font: var(--md-sys-typescale-body-large);
    outline: none;
    min-width: 0;
  }
  input::placeholder {
    color: var(--md-sys-color-on-surface-variant);
    opacity: 0.6;
  }
  input:hover {
    border-color: var(--md-sys-color-on-surface);
  }
  input:focus-visible {
    border-color: var(--md-sys-color-primary);
    box-shadow: inset 0 0 0 1px var(--md-sys-color-primary);
  }
  input.invalid {
    border-color: var(--md-sys-color-error);
    box-shadow: inset 0 0 0 1px var(--md-sys-color-error);
  }
  input.code {
    font-size: 1.5rem;
    font-weight: 500;
    letter-spacing: 0.2em;
    font-variant-numeric: tabular-nums;
    text-transform: uppercase;
  }

  .chips {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .filter {
    position: relative;
    isolation: isolate;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 12px;
    border: 1px solid var(--md-sys-color-outline);
    border-radius: var(--md-sys-shape-corner-small);
    background: none;
    color: var(--md-sys-color-on-surface-variant);
    font: var(--md-sys-typescale-label-large);
    cursor: pointer;
    outline: none;
  }
  .filter.on {
    background: var(--md-sys-color-secondary-container);
    color: var(--md-sys-color-on-secondary-container);
    border-color: transparent;
  }
  .filter::before,
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
  .filter:hover::before,
  .filled:hover:not(:disabled)::before,
  .text:hover::before {
    opacity: var(--md-sys-state-hover-opacity);
  }
  .filter:focus-visible::before,
  .filled:focus-visible::before,
  .text:focus-visible::before {
    opacity: var(--md-sys-state-focus-opacity);
  }
  .filter:active::before,
  .filled:active:not(:disabled)::before,
  .text:active::before {
    opacity: var(--md-sys-state-pressed-opacity);
  }
  .filter:focus-visible,
  .filled:focus-visible,
  .text:focus-visible {
    outline: 2px solid var(--md-sys-color-primary);
    outline-offset: 2px;
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
  .filled:disabled {
    background: color-mix(in srgb, var(--md-sys-color-on-surface) 12%, transparent);
    color: color-mix(in srgb, var(--md-sys-color-on-surface) 38%, transparent);
    cursor: not-allowed;
  }
  .text {
    padding: 0 12px;
    background: none;
    color: var(--md-sys-color-primary);
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
  .banner.ok {
    background: var(--md-sys-color-primary-container);
    color: var(--md-sys-color-on-primary-container);
  }
  .banner.bad {
    background: var(--md-sys-color-error-container);
    color: var(--md-sys-color-on-error-container);
  }
  code {
    font: inherit;
    font-weight: 600;
  }

  @media (max-width: 560px) {
    .card {
      padding: 20px 16px;
    }
  }
</style>
