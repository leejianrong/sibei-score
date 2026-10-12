<script lang="ts">
  /**
   * The screen a signed-out person sees on a hosted deployment (V20b), in place of the library.
   *
   * Sign-in is a plain link to the server, not a fetch: the OAuth round trip happens entirely
   * server-side and ends back on `/` with a cookie, so no GitHub code or token reaches this bundle.
   * The one thing done first is remembering where the person was, so the trip can return there.
   *
   * Material 3, tokens only (`m3.css`): a filled card (surface-container-low, corner-medium, elevation 1)
   * holding a filled button (primary, full corner, label-large, with its hover/focus/pressed state layer).
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

<section class="gate" aria-labelledby="gate-title">
  <div class="card">
    <h1 id="gate-title">Jazz lead sheets you can print</h1>
    <p class="lede">Sign in to open your charts. Your library is private to your account.</p>
    <a class="filled" href={SIGN_IN_PATH} onclick={remember}>
      <svg viewBox="0 0 16 16" aria-hidden="true" width="18" height="18">
        <path
          fill="currentColor"
          d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.71 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.96 0-.87.31-1.59.83-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.52.56.83 1.28.83 2.15 0 3.08-1.87 3.76-3.66 3.96.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0z"
        />
      </svg>
      Sign in with GitHub
    </a>
    <p class="support">Only your public GitHub profile is read. No email.</p>
  </div>
</section>

<style>
  .gate {
    display: grid;
    place-items: center;
    padding: 48px 16px;
    min-height: calc(100vh - var(--top-h));
  }

  .card {
    width: min(400px, 100%);
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 28px 24px 24px;
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

  p {
    margin: 0;
  }
  .lede {
    font: var(--md-sys-typescale-body-medium);
    color: var(--md-sys-color-on-surface-variant);
  }
  .support {
    font: var(--md-sys-typescale-body-small);
    color: var(--md-sys-color-on-surface-variant);
  }

  /* Filled button. The state layer is a pseudo-element wash in the on-colour, so hover, focus and
     press each keep the spec's opacity rather than a hand-darkened background. */
  .filled {
    position: relative;
    isolation: isolate;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 40px;
    padding: 0 24px 0 16px;
    border-radius: var(--md-sys-shape-corner-full);
    background: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-primary);
    font: var(--md-sys-typescale-label-large);
    letter-spacing: var(--md-sys-typescale-label-large-tracking);
    text-decoration: none;
    outline: none;
    align-self: flex-start;
  }
  .filled::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background: var(--md-sys-color-on-primary);
    opacity: 0;
    transition: opacity var(--md-sys-motion-duration-short3) var(--md-sys-motion-easing-standard);
  }
  .filled:hover::before {
    opacity: var(--md-sys-state-hover-opacity);
  }
  .filled:focus-visible::before {
    opacity: var(--md-sys-state-focus-opacity);
  }
  .filled:focus-visible {
    outline: 2px solid var(--md-sys-color-primary);
    outline-offset: 2px;
  }
  .filled:active::before {
    opacity: var(--md-sys-state-pressed-opacity);
  }
</style>
