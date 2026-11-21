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
  import { ARTICULATIONS, parsePitch } from '@sibei/model';
  import type { AccidentalDisplay, Articulation, Dots, Duration, Id, NoteValue, Spanner, TieRole } from '@sibei/model';
  import { untrack } from 'svelte';
  import SegmentedControl from './SegmentedControl.svelte';

  export interface NoteSelection {
    kind: 'note';
    id: Id;
    pitch: string;
    duration: Duration;
    accidental: AccidentalDisplay;
    tie: TieRole;
    /** Whether this note's spelling is pinned against transposition (ADR-0017). V6e. */
    spellingPinned: boolean;
    /** Whether a fermata sits over this note (SIB2-183). */
    fermata: boolean;
    /** Staccato, accent and marcato marks on this note (SIB2-179). */
    articulations: readonly Articulation[];
    /** The grace notes before this note (SIB2-185), each removable. */
    graces: readonly { id: Id; pitch: string; value: 8 | 16 | 32; slashed: boolean }[];
  }

  export interface RestSelection {
    kind: 'rest';
    id: Id;
    duration: Duration;
    fermata: boolean;
  }

  export type Selection = NoteSelection | RestSelection;

  /** The tuplet the selected item sits in, if any (SIB2-166), read from the stored score. */
  export interface TupletInfo {
    actual: number;
    normal: number;
  }

  export interface NoteEdits {
    pitch: string;
    duration: Duration;
    accidental: AccidentalDisplay;
    spellingPinned: boolean;
    articulations: Articulation[];
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
    /** Set when a second note is shift-clicked beside this one: the slur Add slur would make (SIB2-168). */
    pendingSlur?: { with: Id } | null;
    /** The slurs that begin or end on this note, each removable. */
    slurs?: readonly Spanner[];
    onfermata?: (on: boolean) => void;
    onslur?: (placement: 'auto' | 'above' | 'below') => void;
    onrmslur?: (id: Id) => void;
    /** Ottava lines (SIB2-184) covering this note, and the controls that add one over the two selected notes. */
    ottavas?: readonly Spanner[];
    onottava?: (shift: 'up' | 'down') => void;
    onrmottava?: (id: Id) => void;
    /** Grace notes (SIB2-185): add one before this note, or remove one by its id. Both apply at once. */
    ongraceadd?: (grace: { pitch: string; value: 8 | 16 | 32; slashed: boolean }) => void;
    ongracerm?: (id: Id) => void;
    onsave: (edits: NoteEdits | RestEdits) => void;
    /** The tuplet holding this item, or null. */
    tuplet?: TupletInfo | null;
    /** Bracket `count` items from this one as `actual` in the time of `normal` (`tuplet.set`). */
    onsettuplet?: (actual: number, normal: number, count: number) => void;
    /** Take the bracket off (`tuplet.rm`). */
    onremovetuplet?: () => void;
    ondeselect: () => void;
    onreload: () => void;
  }

  const {
    selection,
    conflict,
    saving,
    error,
    pendingSlur = null,
    slurs = [],
    onfermata,
    onslur,
    onrmslur,
    ottavas = [],
    onottava,
    onrmottava,
    ongraceadd,
    ongracerm,
    onsave,
    tuplet = null,
    onsettuplet,
    onremovetuplet,
    ondeselect,
    onreload,
  }: Props = $props();

  // The ratios a lead sheet uses; the CLI takes any `--notes`/`--in`.
  const TUPLET_PRESETS: readonly { label: string; actual: number; normal: number }[] = [
    { label: 'Triplet 3:2', actual: 3, normal: 2 },
    { label: 'Duplet 2:3', actual: 2, normal: 3 },
    { label: 'Quintuplet 5:4', actual: 5, normal: 4 },
    { label: 'Sextuplet 6:4', actual: 6, normal: 4 },
    { label: 'Septuplet 7:4', actual: 7, normal: 4 },
  ];
  let presetIndex = $state(0);
  let tupletCount = $state(3);
  const preset = $derived(TUPLET_PRESETS[presetIndex] ?? TUPLET_PRESETS[0]!);

  function pickPreset(index: number): void {
    presetIndex = index;
    tupletCount = TUPLET_PRESETS[index]?.actual ?? 3;
  }

  // The grace note being composed (SIB2-185): a pitch, a flag value and whether it is slashed.
  let gracePitch = $state('');
  let graceValue = $state<8 | 16 | 32>(8);
  let graceSlashed = $state(true);
  let graceError = $state<string | null>(null);

  function addGrace(): void {
    try {
      parsePitch(gracePitch);
    } catch {
      graceError = `${JSON.stringify(gracePitch)} is not a pitch — try Eb4, F#5, or C4`;
      return;
    }
    graceError = null;
    ongraceadd?.({ pitch: gracePitch, value: graceValue, slashed: graceSlashed });
    gracePitch = '';
  }

  const NOTE_VALUES: readonly NoteValue[] = [1, 2, 4, 8, 16, 32];
  const DOT_COUNTS: readonly Dots[] = [0, 1, 2];
  const ACCIDENTALS: readonly AccidentalDisplay[] = ['auto', 'show', 'hide', 'parens'];

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
  let spellingPinned = $state(untrack(() => (selection.kind === 'note' ? selection.spellingPinned : false)));
  let marks = $state<Articulation[]>(untrack(() => (selection.kind === 'note' ? [...selection.articulations] : [])));
  let pitchError = $state<string | null>(null);

  function toggleMark(mark: Articulation): void {
    marks = marks.includes(mark) ? marks.filter((m) => m !== mark) : ARTICULATIONS.filter((m) => m === mark || marks.includes(m));
  }
  let slurPlacement = $state<'auto' | 'above' | 'below'>('auto');

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
    onsave({ pitch: pitchInput, duration, accidental, spellingPinned, articulations: marks });
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
          display={(option) => (option === 'parens' ? '(♯)' : option.charAt(0).toUpperCase() + option.slice(1))}
          onselect={(chosen) => (accidental = chosen)}
        />
      </div>

      <div class="field">
        <span class="field-label">Articulation</span>
        <div class="dots" role="group" aria-label="Articulation">
          {#each ARTICULATIONS as mark (mark)}
            <button type="button" class="mark" aria-pressed={marks.includes(mark)} onclick={() => toggleMark(mark)}>
              {mark.charAt(0).toUpperCase() + mark.slice(1)}
            </button>
          {/each}
        </div>
      </div>

      <label class="pin">
        <input
          type="checkbox"
          checked={spellingPinned}
          onchange={(event) => (spellingPinned = (event.currentTarget as HTMLInputElement).checked)}
        />
        <span class="pin-text">
          Pin spelling
          <em>Keeps this spelling through a transpose. Off, the destination key decides it.</em>
        </span>
      </label>
    {/if}

    <label class="pin">
      <input
        type="checkbox"
        checked={selection.fermata}
        disabled={saving}
        onchange={(event) => onfermata?.((event.currentTarget as HTMLInputElement).checked)}
      />
      <span class="pin-text">
        Fermata
        <em>A hold sign over this {selection.kind}. Applies at once, like the slur controls.</em>
      </span>
    </label>

    {#if selection.kind === 'note'}
      <div class="field slur-field">
        <span class="field-label">Slur</span>
        {#if pendingSlur !== null}
          <p class="inspector-note">Slur this note to {pendingSlur.with}.</p>
          <SegmentedControl
            label="Slur placement"
            options={['auto', 'above', 'below'] as const}
            value={slurPlacement}
            display={(option) => option.charAt(0).toUpperCase() + option.slice(1)}
            onselect={(chosen) => (slurPlacement = chosen)}
          />
          <button type="button" class="btn btn-save" disabled={saving} onclick={() => onslur?.(slurPlacement)}>
            Add slur
          </button>
        {:else}
          <p class="inspector-note">Shift-click a second note to slur from one to the other.</p>
        {/if}
        {#each slurs as slur (slur.id)}
          <div class="slur-row">
            <span>{slur.id} · {slur.startId} to {slur.endId}</span>
            <button type="button" class="btn btn-cancel" disabled={saving} onclick={() => onrmslur?.(slur.id)}>
              Remove
            </button>
          </div>
        {/each}
      </div>

      {#if ongraceadd !== undefined}
        <div class="field slur-field" role="group" aria-label="Grace notes">
          <span class="field-label">Grace notes</span>
          {#each selection.graces as grace (grace.id)}
            <div class="slur-row">
              <span>{grace.pitch} · {grace.value}{grace.slashed ? ' · slashed' : ''}</span>
              <button type="button" class="btn btn-cancel" disabled={saving} onclick={() => ongracerm?.(grace.id)}>
                Remove
              </button>
            </div>
          {/each}
          <div class="slur-row">
            <input
              class="grace-pitch"
              aria-label="Grace note name"
              placeholder="D5"
              value={gracePitch}
              oninput={(event) => (gracePitch = (event.currentTarget as HTMLInputElement).value)}
            />
            <select
              aria-label="Grace note length"
              value={graceValue}
              onchange={(event) => (graceValue = Number((event.currentTarget as HTMLSelectElement).value) as 8 | 16 | 32)}
            >
              <option value={8}>8th</option>
              <option value={16}>16th</option>
              <option value={32}>32nd</option>
            </select>
            <label class="grace-slash">
              <input
                type="checkbox"
                checked={graceSlashed}
                onchange={(event) => (graceSlashed = (event.currentTarget as HTMLInputElement).checked)}
              />
              Slashed
            </label>
          </div>
          <button type="button" class="btn btn-save" disabled={saving || gracePitch === ''} onclick={addGrace}>
            Add grace note
          </button>
          {#if graceError !== null}<p class="inspector-note" role="alert">{graceError}</p>{/if}
          <p class="inspector-note">Played just before this note and takes no time. Applies at once (<code>grace add</code>).</p>
        </div>
      {/if}

      <div class="field slur-field">
        <span class="field-label">Ottava</span>
        {#if pendingSlur !== null}
          <p class="inspector-note">Put an 8va or 8vb line over the notes from this one to {pendingSlur.with}.</p>
          <div class="slur-row">
            <button type="button" class="btn btn-save" disabled={saving} onclick={() => onottava?.('up')}>8va</button>
            <button type="button" class="btn btn-save" disabled={saving} onclick={() => onottava?.('down')}>8vb</button>
          </div>
        {:else}
          <p class="inspector-note">Shift-click a second note to put an 8va or 8vb line over the run.</p>
        {/if}
        {#each ottavas as line (line.id)}
          <div class="slur-row">
            <span>{line.id} · {line.octaveShift === 'down' ? '8vb' : '8va'}</span>
            <button type="button" class="btn btn-cancel" disabled={saving} onclick={() => onrmottava?.(line.id)}>
              Remove
            </button>
          </div>
        {/each}
      </div>
    {/if}

    {#if onsettuplet !== undefined}
      <div class="field tuplet" role="group" aria-label="Tuplet">
        <span class="field-label">Tuplet</span>
        {#if tuplet !== null}
          <p class="inspector-note">
            In a {tuplet.actual}:{tuplet.normal} tuplet.
          </p>
          <button type="button" class="btn btn-cancel" disabled={saving} onclick={onremovetuplet}>
            Remove tuplet
          </button>
        {:else}
          <select
            class="tuplet-ratio"
            aria-label="Tuplet ratio"
            value={presetIndex}
            onchange={(event) => pickPreset(Number((event.currentTarget as HTMLSelectElement).value))}
          >
            {#each TUPLET_PRESETS as option, index (option.label)}
              <option value={index}>{option.label}</option>
            {/each}
          </select>
          <label class="tuplet-count">
            <span class="field-label">Items</span>
            <input
              type="number"
              min="1"
              max="32"
              aria-label="Items the tuplet spans"
              value={tupletCount}
              oninput={(event) => (tupletCount = Number((event.currentTarget as HTMLInputElement).value))}
            />
          </label>
          <button
            type="button"
            class="btn btn-cancel"
            disabled={saving}
            onclick={() => onsettuplet?.(preset.actual, preset.normal, tupletCount)}
          >
            Bracket from here
          </button>
          <p class="inspector-note">
            Brackets this item and the next ones as one tuplet; later items close up to follow.
          </p>
        {/if}
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

  .slur-field .btn {
    flex: none;
  }
  .slur-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    color: var(--ink-soft);
  }
  .grace-pitch {
    width: 56px;
    font: inherit;
    font-size: 11px;
  }
  .grace-slash {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .slur-row .btn {
    flex: none;
    padding: 4px 8px;
  }

  .dots button.mark {
    width: auto;
    padding: 0 8px;
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

  /* The spelling pin (V6e, ADR-0017). A checkbox rather than a segmented control: it is a plain
     on/off, and the caption carries the meaning the two states cannot. */
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

  .tuplet-ratio,
  .tuplet-count input {
    background: var(--panel-2);
    border: 1px solid var(--rule);
    padding: 7px 9px;
    font-size: 13px;
    color: var(--ink);
  }
  .tuplet-count {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .tuplet-count input {
    width: 70px;
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
