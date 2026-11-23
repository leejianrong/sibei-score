<script lang="ts">
  /**
   * A chart is open and the server stopped answering (SIB2-266): either the live stream dropped, or a write
   * was refused for want of an answer. It is the account banner's pattern (`SessionBanner`: Material 3 tokens
   * only, one typeface, a text button on the right) in the error roles, sticky under the top bar so it is in
   * view whatever the rail or the sheet is scrolled to. Nothing is retried silently: a write that did not
   * land is a write the person should know about, and Retry sends exactly that batch again.
   */
  interface Props {
    /** The bold lead, e.g. `Connection lost.` */
    title: string;
    /** The rest of the sentence. */
    detail: string;
    /** Send the failed write again. Absent for a lost stream, which reconnects on its own. */
    onretry?: () => void;
    ondismiss?: () => void;
    busy?: boolean;
  }

  const { title, detail, onretry, ondismiss, busy = false }: Props = $props();
</script>

<div class="banner" role="alert">
  <p class="message"><strong>{title}</strong> {detail}</p>
  {#if onretry}<button type="button" class="text" disabled={busy} onclick={onretry}>Retry</button>{/if}
  {#if ondismiss}<button type="button" class="text" onclick={ondismiss}>Dismiss</button>{/if}
</div>

<style>
  .banner {
    position: sticky;
    top: var(--top-h);
    z-index: 15;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 12px;
    padding: 8px 16px 8px 18px;
    background: var(--md-sys-color-error-container);
    color: var(--md-sys-color-on-error-container);
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
  .text {
    position: relative;
    isolation: isolate;
    display: inline-flex;
    align-items: center;
    height: 40px;
    padding: 0 12px;
    border: 0;
    background: none;
    cursor: pointer;
    border-radius: var(--md-sys-shape-corner-full);
    color: var(--md-sys-color-on-error-container);
    font: var(--md-sys-typescale-label-large);
    letter-spacing: var(--md-sys-typescale-label-large-tracking);
    outline: none;
  }
  .text::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background: var(--md-sys-color-on-error-container);
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
    outline: 2px solid var(--md-sys-color-on-error-container);
    outline-offset: 1px;
  }
  .text:active::before {
    opacity: var(--md-sys-state-pressed-opacity);
  }
  .text:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
