<script lang="ts">
  /**
   * The room below Export — V4c. What a click on the sheet resolves to, and the only place in
   * the browser an edit can start.
   *
   * **Pitch, duration and accidental. Nothing else.** SLICES.md's V4 step 3 names exactly those
   * three, and Q79 is why this stays there: `note.set`'s `tie` field has no control here on
   * purpose — inventing one is a later card's decision, not a convenience to reach for now.
   *
   * **A rest asks for only what applies to a rest.** It has no pitch and draws no accidental, so
   * this component takes a `kind`-narrowed `Selection` rather than one shape with fields that
   * would be meaningless half the time.
   *
   * **Save never decides what the server thinks the version is.** It calls `onsave` with the
   * edited fields; the caller (`ScoreView`) is the one that knows the score's `version` and the
   * one that owns the conflict recovery rule (ADR-0003): reload, never retry with the server's
   * number wearing a disguise.
   */
  import { parsePitch } from '@sibei/model';
  import type { AccidentalDisplay, Dots, Duration, Id, NoteValue, TieRole } from '@sibei/model';
  import { untrack } from 'svelte';
  import SegmentedControl from './SegmentedControl.svelte';

  export interface NoteSelection {
    kind: 'note';
    id: Id;
    pitch: string;
    duration: Duration;
    accidental: AccidentalDisplay;
    tie: TieRole;
  }

  export interface RestSelection {
    kind: 'rest';
    id: Id;
    duration: Duration;
  }

  export type Selection = NoteSelection | RestSelection;

  export interface NoteEdits {
    pitch: string;
    duration: Duration;
    accidental: AccidentalDisplay;
  }

  export interface RestEdits {
    duration: Duration;
  }

  interface Props {
    selection: Selection;
    /** True once a save on this selection came back 409: the server moved on without this edit. */
    conflict: boolean;
    saving: boolean;
    /** A validation message this component could not resolve on its own — an unparseable pitch. */
    error: string | null;
    onsave: (edits: NoteEdits | RestEdits) => void;
    ondeselect: () => void;
    onreload: () => void;
  }

  const { selection, conflict, saving, error, onsave, ondeselect, onreload }: Props = $props();

  const NOTE_VALUES: readonly NoteValue[] = [1, 2, 4, 8, 16, 32];
  const DOT_COUNTS: readonly Dots[] = [0, 1, 2];
  const ACCIDENTALS: readonly AccidentalDisplay[] = ['auto', 'show', 'hide'];

  // Seeded from the selection once: `ScoreView` mounts a fresh `Inspector` per selection (keyed
  // on its id), so these never need to notice a *different* item arriving — only edits to this
  // one. `untrack` says so explicitly, rather than leaving it looking like a bug that never
  // reacts to a `selection` no caller ever actually replaces in place.
  let pitchInput = $state(untrack(() => (selection.kind === 'note' ? selection.pitch : '')));
  let value = $state<NoteValue>(untrack(() => selection.duration.value));
  let dots = $state<Dots>(untrack(() => selection.duration.dots));
  let accidental = $state<AccidentalDisplay>(
    untrack(() => (selection.kind === 'note' ? selection.accidental : 'auto')),
  );
  let pitchError = $state<string | null>(null);

  const tieHint = $derived(selection.kind === 'note' ? hintFor(selection.tie) : null);

  function hintFor(tie: TieRole): string | null {
    const carries = 'the tie carries over, whichever pitch or duration this becomes.';
    if (tie === 'start') return `Tied to the note after it — ${carries}`;
    if (tie === 'stop') return `Tied to the note before it — ${carries}`;
    if (tie === 'both') return `Tied to the notes before and after it — ${carries}`;
    return null;
  }

  function save(): void {
    const duration: Duration = { value, dots };
    if (selection.kind === 'rest') {
      onsave({ duration });
      return;
    }
    try {
      parsePitch(pitchInput);
    } catch {
      pitchError = `${JSON.stringify(pitchInput)} is not a pitch — try Eb4, F#5, or C4`;
      return;
    }
    pitchError = null;
    onsave({ pitch: pitchInput, duration, accidental });
  }
</script>

<div class="inspector">
  <div class="inspector-head">
    <span class="inspector-kind"><b>{selection.kind === 'note' ? 'Note' : 'Rest'}</b> selected</span>
    <span class="inspector-addr">{selection.id}</span>
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
    {#if selection.kind === 'note'}
      <div class="field">
        <span class="field-label">Pitch</span>
        <input
          class="pitch-input"
          aria-label="Pitch"
          value={pitchInput}
          oninput={(event) => (pitchInput = (event.currentTarget as HTMLInputElement).value)}
        />
        {#if pitchError !== null}
          <p class="field-error">{pitchError}</p>
        {/if}
      </div>
    {/if}

    <div class="field">
      <span class="field-label">Duration</span>
      <SegmentedControl
        label={selection.kind === 'note' ? 'Note value' : 'Rest value'}
        options={NOTE_VALUES}
        value={value}
        onselect={(chosen) => (value = chosen)}
      />
      <div class="dots-row">
        <span class="field-label">Dots</span>
        <div class="dots" role="group" aria-label="Dots">
          {#each DOT_COUNTS as count (count)}
            <button
              type="button"
              aria-pressed={count === dots}
              onclick={() => (dots = count)}
            >
              {count}
            </button>
          {/each}
        </div>
      </div>
    </div>

    {#if selection.kind === 'note'}
      <div class="field">
        <span class="field-label">Accidental</span>
        <SegmentedControl
          label="Accidental display"
          options={ACCIDENTALS}
          value={accidental}
          display={(option) => option.charAt(0).toUpperCase() + option.slice(1)}
          onselect={(chosen) => (accidental = chosen)}
        />
      </div>
    {/if}

    {#if tieHint !== null}
      <p class="inspector-note">{tieHint}</p>
    {/if}

    {#if error !== null}
      <p class="field-error">{error}</p>
    {/if}

    <div class="inspector-actions">
      <button type="button" class="btn btn-save" disabled={saving} onclick={save}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button type="button" class="btn btn-cancel" disabled={saving} onclick={ondeselect}>
        Deselect
      </button>
    </div>
  {/if}
</div>

<style>
  .inspector {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .inspector-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .inspector-kind {
    font-size: 12.5px;
    color: var(--ink);
  }
  .inspector-kind b {
    font-weight: 600;
  }
  .inspector-addr {
    font-size: 11px;
    color: var(--ink-faint);
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

  .pitch-input {
    background: var(--panel-2);
    border: 1px solid var(--rule);
    padding: 8px 10px;
    font-size: 14px;
    font-family: var(--mono);
    color: var(--ink);
    width: 100%;
  }
  .pitch-input:focus {
    border-color: var(--accent);
    outline: none;
  }

  .dots-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .dots-row .field-label {
    margin: 0;
  }
  .dots {
    display: flex;
    gap: 4px;
  }
  .dots button {
    width: 26px;
    height: 26px;
    background: var(--panel);
    border: 1px solid var(--rule);
    cursor: pointer;
    color: var(--ink-soft);
    font-size: 12px;
  }
  .dots button[aria-pressed='true'] {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }

  .inspector-actions {
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
  .btn-cancel {
    background: transparent;
    border-color: var(--rule);
    color: var(--ink-soft);
  }
  .btn-cancel:hover:not(:disabled) {
    border-color: var(--ink-faint);
    color: var(--ink);
  }

  .inspector-note {
    font-size: 11px;
    color: var(--ink-faint);
    line-height: 1.55;
    margin: 0;
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
  .conflict .btn-reload:hover {
    filter: brightness(1.08);
  }
</style>
