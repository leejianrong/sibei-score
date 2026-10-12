<script lang="ts">
  /**
   * The account chip at the right of the top bar, and the menu behind it (V20b).
   *
   * A button that opens a menu holding the person's name and one action, Sign out. It follows the
   * menu pattern's keyboard contract: opening puts focus on the first item, Escape closes and returns
   * focus to the chip, and leaving the menu by Tab or by clicking elsewhere closes it.
   *
   * Material 3, tokens only (`m3.css`): the avatar is a primary-container disc; the menu is a
   * surface-container sheet with corner-extra-small and elevation 2; items carry the state layer.
   */
  import { displayName, initialOf } from '../lib/session.js';
  import type { Account } from '../lib/session.js';

  interface Props {
    account: Account;
    onSignOut: () => void;
  }

  const { account, onSignOut }: Props = $props();

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();
  let chip: HTMLButtonElement | undefined = $state();
  let firstItem: HTMLButtonElement | undefined = $state();

  async function toggle(): Promise<void> {
    open = !open;
    if (open) {
      await Promise.resolve();
      firstItem?.focus();
    }
  }

  function close(returnFocus: boolean): void {
    open = false;
    if (returnFocus) chip?.focus();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (open && event.key === 'Escape') {
      event.stopPropagation();
      close(true);
    }
  }

  function onFocusOut(event: FocusEvent): void {
    // Tabbing out of the whole widget closes it; moving between the chip and its menu does not.
    if (open && !root?.contains(event.relatedTarget as Node | null)) open = false;
  }

  function onWindowPointerDown(event: PointerEvent): void {
    if (open && !root?.contains(event.target as Node | null)) open = false;
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="account" bind:this={root} onkeydown={onKeydown} onfocusout={onFocusOut} role="presentation">
  <button
    class="chip"
    type="button"
    bind:this={chip}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls="account-menu"
    onclick={toggle}
  >
    <span class="avatar" aria-hidden="true">{initialOf(account)}</span>
    <span class="login">{account.login}</span>
  </button>

  {#if open}
    <div class="menu" id="account-menu" role="menu" aria-label="Account">
      <div class="who">
        <span class="name">{displayName(account)}</span>
        <span class="handle">@{account.login} · signed in with GitHub</span>
      </div>
      <button
        class="item"
        type="button"
        role="menuitem"
        bind:this={firstItem}
        onclick={() => {
          close(false);
          onSignOut();
        }}
      >
        Sign out
      </button>
    </div>
  {/if}
</div>

<style>
  .account {
    position: relative;
  }

  /* The trigger is a text-style button: no fill at rest, a state layer on interaction. */
  .chip {
    position: relative;
    isolation: isolate;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 12px 0 4px;
    border: 0;
    border-radius: var(--md-sys-shape-corner-full);
    background: none;
    color: var(--md-sys-color-on-surface);
    font: var(--md-sys-typescale-label-large);
    letter-spacing: var(--md-sys-typescale-label-large-tracking);
    cursor: pointer;
    outline: none;
  }
  .chip::before,
  .item::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background: var(--md-sys-color-on-surface);
    opacity: 0;
    transition: opacity var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard);
  }
  .chip:hover::before,
  .item:hover::before {
    opacity: var(--md-sys-state-hover-opacity);
  }
  .chip:focus-visible::before,
  .item:focus-visible::before,
  .chip[aria-expanded='true']::before {
    opacity: var(--md-sys-state-focus-opacity);
  }
  .chip:active::before,
  .item:active::before {
    opacity: var(--md-sys-state-pressed-opacity);
  }
  .chip:focus-visible {
    outline: 2px solid var(--md-sys-color-primary);
    outline-offset: 1px;
  }

  .avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--md-sys-color-primary-container);
    color: var(--md-sys-color-on-primary-container);
    font: var(--md-sys-typescale-label-large);
    font-size: 0.75rem;
    line-height: 1;
  }

  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    z-index: 30;
    min-width: 240px;
    padding: 8px 0;
    background: var(--md-sys-color-surface-container);
    color: var(--md-sys-color-on-surface);
    border-radius: var(--md-sys-shape-corner-extra-small);
    box-shadow: var(--md-sys-elevation-level2);
    transform-origin: top right;
    animation: unfold var(--md-sys-motion-duration-medium1) var(--md-sys-motion-easing-emphasized-decelerate);
  }
  @keyframes unfold {
    from {
      opacity: 0;
      transform: scaleY(0.9);
    }
  }

  .who {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 16px 12px;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
    margin-bottom: 8px;
  }
  .name {
    font: var(--md-sys-typescale-title-medium);
    overflow-wrap: anywhere;
  }
  .handle {
    font: var(--md-sys-typescale-body-small);
    color: var(--md-sys-color-on-surface-variant);
    overflow-wrap: anywhere;
  }

  .item {
    position: relative;
    isolation: isolate;
    display: block;
    width: 100%;
    height: 48px;
    padding: 0 16px;
    border: 0;
    background: none;
    color: var(--md-sys-color-on-surface);
    text-align: left;
    font: var(--md-sys-typescale-label-large);
    letter-spacing: var(--md-sys-typescale-label-large-tracking);
    cursor: pointer;
    outline: none;
  }

  /* On a phone the chip is the avatar alone, and the menu still names the account. */
  @media (max-width: 560px) {
    .login {
      display: none;
    }
    .chip {
      padding-right: 4px;
    }
  }
</style>
