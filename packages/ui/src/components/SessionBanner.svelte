<script lang="ts">
  /**
   * Shown when a request came back 401 while a chart was open (V20b): the session expired, or it was
   * ended in another tab. The chart stays on screen and readable under this, and nothing is retried
   * silently, because a write that was refused is a write the person should know about.
   *
   * Material 3 banner, tokens only (`m3.css`): secondary-container surface, a text button on the right.
   */
  import { SIGN_IN_PATH } from '../lib/api.js';
  import { rememberReturn } from '../lib/session.js';

  function remember(): void {
    try {
      rememberReturn(window.location.hash, window.sessionStorage);
    } catch {
      // sessionStorage can be blocked; the person lands in the library afterwards
    }
  }
</script>

<div class="banner" role="alert">
  <p class="message"><strong>You have been signed out.</strong> Your last change may not have saved.</p>
  <a class="text" href={SIGN_IN_PATH} onclick={remember}>Sign in again</a>
</div>

<style>
  .banner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 16px;
    padding: 12px 16px 12px 18px;
    background: var(--md-sys-color-secondary-container);
    color: var(--md-sys-color-on-secondary-container);
  }
  .message {
    margin: 0;
    flex: 1 1 280px;
    min-width: 0;
    font: var(--md-sys-typescale-body-medium);
  }
  .message strong {
    font-weight: 600;
  }

  /* Text button: no container, the primary role for the label, a state layer on interaction. */
  .text {
    position: relative;
    isolation: isolate;
    display: inline-flex;
    align-items: center;
    height: 40px;
    padding: 0 12px;
    border-radius: var(--md-sys-shape-corner-full);
    color: var(--md-sys-color-primary);
    font: var(--md-sys-typescale-label-large);
    letter-spacing: var(--md-sys-typescale-label-large-tracking);
    text-decoration: none;
    outline: none;
  }
  .text::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background: var(--md-sys-color-primary);
    opacity: 0;
    transition: opacity var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard);
  }
  .text:hover::before {
    opacity: var(--md-sys-state-hover-opacity);
  }
  .text:focus-visible::before {
    opacity: var(--md-sys-state-focus-opacity);
  }
  .text:focus-visible {
    outline: 2px solid var(--md-sys-color-primary);
    outline-offset: 1px;
  }
  .text:active::before {
    opacity: var(--md-sys-state-pressed-opacity);
  }
</style>
