<script lang="ts">
  /**
   * Editing a chord symbol — V5e. The sibling of `Inspector.svelte`: a click on a chord opens this
   * in edit mode, a click on the empty band above a bar opens it in add mode for that beat (Q32).
   *
   * **The grammar validates as you type, and never blocks.** `@sibei/music` parses the text on every
   * keystroke: a symbol it reads shows what it reads and previews the real engraving (the same
   * `chordSymbol` the sheet draws with), and one it cannot read says so — but Save is *never*
   * disabled for it, because unparseable text is stored verbatim and flagged, not rejected
   * (ADR-0012). Teaching that in the UI is the whole point of showing the flag rather than an error.
   *
   * **Save owns no version.** Like the note inspector, it hands the text up; `ScoreView` knows the
   * version, submits `chord.set`/`chord.rm` to the one write path, and owns the 409 reload.
   */
  import { chordSymbol, serialise } from '@sibei/engrave';
  import { formatChord, parseChord } from '@sibei/music';
  import { untrack } from 'svelte';
  import { CLI_BINARY } from '../lib/branding.js';

  export interface ChordSelection {
    /** `bar3.beat1` — the beat this chord is anchored to (ADR-0007, Q32). */
    addr: string;
    mode: 'add' | 'edit';
    /** The verbatim text to seed the field with; empty in add mode. */
    text: string;
    barNumber: number;
    beat: number;
    /** Whether the root's spelling is pinned against transposition (ADR-0017). V6e. */
    spellingPinned: boolean;
  }

  interface Props {
    chord: ChordSelection;
    conflict: boolean;
    saving: boolean;
    error: string | null;
    onsave: (text: string, spellingPinned: boolean) => void;
    onremove: () => void;
    ondeselect: () => void;
    onreload: () => void;
  }

  const { chord, conflict, saving, error, onsave, onremove, ondeselect, onreload }: Props = $props();

  // Seeded once from the selection: `ScoreView` keys a fresh `ChordInspector` per selected chord
  // (on mode+addr), so this never needs to react to a *different* chord arriving in place — only to
  // the keystrokes below. `untrack` says so, matching the note inspector.
  let text = $state(untrack(() => chord.text));
  let spellingPinned = $state(untrack(() => chord.spellingPinned));

  // The live reading. Recomputed each keystroke; nothing here is stored or sent — it only says what
  // the grammar makes of the text so far.
  const reading = $derived.by(() => {
    const trimmed = text.trim();
    if (trimmed === '') return { state: 'empty' as const };
    const parsed = parseChord(trimmed);
    if (parsed === null) return { state: 'flagged' as const };
    if (parsed.kind === 'no-chord') return { state: 'ok' as const, canonical: 'N.C.', note: 'no chord — the bar is unharmonised' };
    const canonical = formatChord(parsed);
    return {
      state: 'ok' as const,
      canonical,
      note: canonical === trimmed ? null : `reads as ${canonical}`,
    };
  });

  // The preview is the *real* engraving: the same `chordSymbol` the sheet composes, so what the
  // field promises is exactly what lands on the page. Only drawn for text the grammar reads.
  const preview = $derived.by(() => {
    if (reading.state !== 'ok') return null;
    const element = chordSymbol({ text: text.trim(), x: 6, y: 30, size: 24, plain: false });
    return serialise(element);
  });

  function save(): void {
    // Trimmed, but never validated-away: the server stores whatever this is and flags it if it must.
    onsave(text.trim(), spellingPinned);
  }
</script>

<div class="chord-insp">
  <div class="insp-head">
    <span class="insp-kind"><b>{chord.mode === 'add' ? 'New chord' : 'Chord'}</b> selected</span>
    <span class="insp-addr">{chord.addr}</span>
  </div>

  {#if conflict}
    <div class="conflict">
      <span class="headline">This chart changed elsewhere.</span>
      <span class="body">
        Someone — or another tab — saved a newer version while this was open. Your edit here was
        never sent. Reload to see the current chart, then try the edit again.
      </span>
      <button type="button" class="btn-reload" onclick={onreload}>Reload chart</button>
    </div>
  {:else}
    <div class="field">
      <span class="field-label">Symbol</span>
      <input
        class="chord-input"
        class:bad={reading.state === 'flagged'}
        aria-label="Chord symbol"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        value={text}
        oninput={(event) => (text = (event.currentTarget as HTMLInputElement).value)}
        onkeydown={(event) => event.key === 'Enter' && !saving && save()}
      />
    </div>

    {#if reading.state === 'ok'}
      <div class="verdict">
        <span class="tag ok">reads</span>
        {#if reading.note !== null}<span class="desc">{reading.note}</span>{/if}
      </div>
      <div class="preview">
        <span class="plabel">Engraves as</span>
        <span class="engraved">{@html preview}</span>
      </div>
    {:else if reading.state === 'flagged'}
      <div class="verdict">
        <span class="tag flag">flagged</span>
        <span class="desc">
          Not a chord the grammar reads — it will be stored <b>verbatim</b> and flagged for review,
          never rejected.
        </span>
      </div>
    {/if}

    <label class="pin">
      <input
        type="checkbox"
        checked={spellingPinned}
        onchange={(event) => (spellingPinned = (event.currentTarget as HTMLInputElement).checked)}
      />
      <span class="pin-text">
        Pin spelling
        <em>Keeps this root through a transpose. Off, the destination key decides it.</em>
      </span>
    </label>

    {#if error !== null}
      <p class="field-error">{error}</p>
    {/if}

    <div class="insp-actions">
      <button type="button" class="btn btn-save" disabled={saving || text.trim() === ''} onclick={save}>
        {saving ? 'Saving…' : chord.mode === 'add' ? 'Add' : 'Save'}
      </button>
      {#if chord.mode === 'edit'}
        <button type="button" class="btn btn-rm" disabled={saving} onclick={onremove}>Remove</button>
      {:else}
        <button type="button" class="btn btn-cancel" disabled={saving} onclick={ondeselect}>Cancel</button>
      {/if}
    </div>

    <p class="hint">
      A chord anchors to a beat, so two chords can share a bar. Save submits <code>chord.set</code>,
      the same op <code>{CLI_BINARY} chord set</code> sends.
    </p>
  {/if}
</div>

<style>
  .chord-insp {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .insp-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .insp-kind {
    font-size: 12.5px;
    color: var(--ink);
  }
  .insp-kind b {
    font-weight: 600;
  }
  .insp-addr {
    font-size: 11px;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .field-label {
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .field-error {
    font-size: 11px;
    color: var(--flag);
    margin: 0;
  }

  .chord-input {
    background: var(--panel-2);
    border: 1px solid var(--rule);
    border-left: 2px solid var(--accent);
    padding: 9px 11px;
    font-size: 16px;
    font-family: var(--mono);
    color: var(--ink);
    width: 100%;
  }
  .chord-input:focus {
    border-color: var(--accent);
    outline: none;
  }
  .chord-input.bad {
    border-left-color: var(--flag);
  }

  .verdict {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 11.5px;
    line-height: 1.5;
  }
  .tag {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 2px 6px;
    white-space: nowrap;
  }
  .tag.ok {
    color: var(--accent);
    background: var(--accent-wash);
  }
  .tag.flag {
    color: var(--flag);
    background: var(--flag-wash);
  }
  .desc {
    color: var(--ink-soft);
  }

  /* A swatch of the printed page: always white paper, in both themes, because that is what the PDF
     is. Pinned rather than themed so the ink below reads the same everywhere. */
  .preview {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    background: #ffffff;
    border: 1px solid var(--rule-soft);
  }
  .plabel {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #6b6f77;
  }
  /* The preview is real engraver markup; force the ink dark so it never dims to the dark theme's
     ground — the swatch is white paper, not the panel. */
  .engraved {
    color: #15171c;
  }
  .engraved :global(svg) {
    display: block;
    height: 34px;
    width: auto;
    overflow: visible;
  }
  .engraved :global(svg text),
  .engraved :global(svg tspan) {
    fill: #15171c !important;
  }

  .insp-actions {
    display: flex;
    gap: 8px;
    margin-top: 2px;
  }
  .btn {
    flex: 1;
    padding: 9px 10px;
    font-size: 12px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
    font-family: var(--mono);
  }
  .btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .btn-save {
    background: var(--accent);
    color: var(--on-accent);
  }
  .btn-save:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .btn-cancel,
  .btn-rm {
    background: transparent;
    border-color: var(--rule);
    color: var(--ink-soft);
  }
  .btn-cancel:hover:not(:disabled) {
    border-color: var(--ink-faint);
    color: var(--ink);
  }
  .btn-rm:hover:not(:disabled) {
    border-color: var(--flag);
    color: var(--flag);
  }

  .hint {
    font-size: 11px;
    color: var(--ink-faint);
    line-height: 1.55;
    margin: 0;
  }
  .hint code {
    font-size: 10.5px;
    color: var(--ink-soft);
  }

  /* The spelling pin (V6e, ADR-0017), the chord twin of the note inspector's. */
  .pin {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    cursor: pointer;
  }
  .pin input {
    margin: 2px 0 0;
    width: 15px;
    height: 15px;
    flex: none;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .pin-text {
    font-size: 12.5px;
    color: var(--ink);
    line-height: 1.4;
  }
  .pin-text em {
    display: block;
    font-style: normal;
    font-size: 11px;
    color: var(--ink-faint);
    margin-top: 2px;
    line-height: 1.5;
  }

  .conflict {
    background: var(--flag-wash);
    border-left: 2px solid var(--flag);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-size: 12px;
    line-height: 1.55;
  }
  .conflict .headline {
    color: var(--ink);
    font-weight: 600;
  }
  .conflict .body {
    color: var(--ink-soft);
  }
  .conflict .btn-reload {
    align-self: flex-start;
    background: var(--flag);
    color: #fff;
    border: 0;
    padding: 8px 14px;
    font-size: 11.5px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    font-weight: 600;
    cursor: pointer;
  }
</style>
