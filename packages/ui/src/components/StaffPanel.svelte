<script lang="ts">
  /**
   * The staves-and-voices panel — ADR-0041, slice 5b. Three jobs, all on the chart's own parts:
   *
   *  - **The active staff and voice.** Click a staff row to make it active, and a voice chip to pick the voice of it;
   *    that lane is where an edit by position lands (the bar panel's New note) and is named in the stage bar.
   *  - **Parts, staves and voices**: new and remove, the browser half of `sbscore part|staff|voice add|rm`. A removal
   *    that would take notes with it is not sent: the row asks first, in place ("remove its notes first, or remove it
   *    with its music"), and only the explicit confirm sends `force`.
   *  - **Clef and instrument**: a staff's opening clef (and a change from the selected bar), a part's name, General
   *    MIDI program and transposition, the browser half of `sbscore clef set` and `instrument set`.
   *
   * Like the inspectors it owns no version and no conflict recovery: every control hands `ScoreView` ops to post, and
   * the ones that change the shape are one undoable unit each (ctrl-Z replays the log without them).
   */
  import type { Clef, Score, StaffType } from '@sibei/model';
  import type { Operation } from '../lib/api.js';
  import { clampLane, laneLabel } from '../lib/lanes.js';
  import type { Lane } from '../lib/lanes.js';
  import {
    CLEFS,
    STAFF_TYPES,
    addPartOp,
    addStaffOp,
    addVoiceOp,
    instrumentOp,
    partRows,
    removePartOp,
    removeStaffOp,
    removeVoiceOp,
    handMoveOp,
    setClefOp,
  } from '../lib/staff-edits.js';
  import type { InstrumentEdits, PartRow, StaffRow } from '../lib/staff-edits.js';

  interface Props {
    score: Score;
    lane: Lane;
    /** The bar selected on the sheet, for a clef change from that bar. */
    barNumber: number | null;
    saving: boolean;
    /** A refusal from the last write, shown here when no inspector is open to show it. */
    error: string | null;
    /** Post ops as one batch; resolves true when they landed. */
    onops: (operations: Operation[]) => Promise<boolean>;
    onlane: (lane: Lane) => void;
  }

  const { score, lane, barNumber, saving, error, onops, onlane }: Props = $props();

  const parts = $derived(partRows(score));
  const staffCount = $derived(parts.reduce((sum, part) => sum + part.staves.length, 0));
  const active = $derived(clampLane(score, lane));
  const activeStaff = $derived(parts.flatMap((part) => part.staves).find((staff) => staff.number === active.staff) ?? null);
  const activePart = $derived(parts.find((part) => part.staves.some((staff) => staff.number === active.staff)) ?? null);

  // What is waiting on a yes: a removal of something that holds music. One at a time, keyed by what it names.
  let confirming = $state<{ key: string; message: string; op: Operation } | null>(null);

  let newClef = $state<Clef>('bass');
  let newStaffType = $state<StaffType>('standard');
  let newPartName = $state('');
  let newPartClef = $state<Clef>('treble');
  let clefFrom = $state<Clef>('bass');

  // The instrument fields are drafts, kept per part and dropped once the chart they were typed against changes.
  let drafts = $state<Record<string, InstrumentEdits>>({});
  let instrumentError = $state<{ part: string; text: string } | null>(null);
  const seedOf = (part: PartRow): InstrumentEdits => ({
    name: part.name,
    shortName: part.shortName,
    program: part.instrument === null ? '' : String(part.instrument),
    transposition: String(part.transposition),
  });
  const draftOf = (part: PartRow): InstrumentEdits => drafts[part.id] ?? seedOf(part);
  function setDraft(part: PartRow, change: Partial<InstrumentEdits>): void {
    drafts = { ...drafts, [part.id]: { ...draftOf(part), ...change } };
  }
  $effect(() => {
    void score;
    drafts = {};
    instrumentError = null;
    confirming = null;
  });

  // The range form (SIB2-244): the correction for a wrong hand split, the browser half of `sbscore hands move`.
  let moveFirst = $state('');
  let moveLast = $state('');
  let moveFrom = $state(1);
  let moveTo = $state(2);
  let moveLimit = $state<'all' | 'below' | 'above'>('all');
  let movePitch = $state('C4');
  let moveError = $state<string | null>(null);

  function moveRange(): void {
    // Blank fields mean the selected bar, and a blank last bar means the first alone.
    const first = moveFirst.trim() === '' && barNumber !== null ? String(barNumber) : moveFirst;
    const parsed = handMoveOp({ first, last: moveLast.trim() === '' ? first : moveLast, from: moveFrom, to: moveTo, limit: moveLimit, pitch: movePitch });
    if (!parsed.ok || parsed.op === null) {
      moveError = parsed.error;
      return;
    }
    moveError = null;
    void run([parsed.op]);
  }

  async function run(operations: Operation[], then?: () => void): Promise<void> {
    const landed = await onops(operations);
    if (landed) then?.();
  }

  /** The number the staff a `staff.add` to this part will have: after the last staff of the part. */
  function nextStaffNumberOf(part: PartRow): number {
    return part.staves.reduce((most, staff) => Math.max(most, staff.number), 0) + 1;
  }

  function askRemoveStaff(staff: StaffRow): void {
    if (!staff.holdsNotation) {
      void run([removeStaffOp(staff, false)]);
      return;
    }
    confirming = {
      key: `staff-${staff.number}`,
      message: `Staff ${staff.number} holds notes or rests. Remove its notes first, or remove it with its music.`,
      op: removeStaffOp(staff, true),
    };
  }

  function askRemovePart(part: PartRow): void {
    if (!part.holdsNotation) {
      void run([removePartOp(part, false)]);
      return;
    }
    confirming = {
      key: `part-${part.number}`,
      message: `Part ${part.number} holds notes or rests. Remove its notes first, or remove it with its music.`,
      op: removePartOp(part, true),
    };
  }

  function askRemoveVoice(staff: StaffRow, voice: number): void {
    const row = staff.voices.find((v) => v.index === voice);
    if (row === undefined) return;
    if (!row.holdsNotation) {
      void run([removeVoiceOp(staff, voice, false)]);
      return;
    }
    confirming = {
      key: `voice-${staff.number}-${voice}`,
      message: `Voice ${voice} of staff ${staff.number} holds notes or rests. Remove its notes first, or remove it with its music.`,
      op: removeVoiceOp(staff, voice, true),
    };
  }

  function saveInstrument(part: PartRow): void {
    const parsed = instrumentOp(part, draftOf(part));
    if (!parsed.ok) {
      instrumentError = { part: part.id, text: parsed.error ?? 'That is not a valid instrument.' };
      return;
    }
    instrumentError = null;
    if (parsed.op !== null) void run([parsed.op]);
  }
</script>

<div class="staves" data-testid="staves-panel">
  <p class="active-line">
    Active: <b data-testid="panel-active-lane">{laneLabel(score, active)}</b>
  </p>

  {#each parts as part (part.id)}
    <div class="part">
      <div class="row">
        <span class="part-title">Part {part.number}{part.name === '' ? '' : ` · ${part.name}`}</span>
        {#if parts.length > 1}
          <button
            type="button"
            class="btn"
            aria-label={`Remove part ${part.number}`}
            disabled={saving}
            onclick={() => askRemovePart(part)}>Remove</button>
        {/if}
      </div>
      {#if confirming?.key === `part-${part.number}`}
        {@render confirmRow(confirming)}
      {/if}

      {#each part.staves as staff (staff.id)}
        <div class="staff" class:is-active={staff.number === active.staff}>
          <div class="row">
            <button
              type="button"
              class="staff-pick"
              aria-label={`Staff ${staff.number}, ${staff.clef} clef`}
              aria-pressed={staff.number === active.staff}
              onclick={() => onlane({ staff: staff.number, voice: staff.number === active.staff ? active.voice : 1 })}
            >
              Staff {staff.number} · {staff.clef}
            </button>
            <div class="chips" role="group" aria-label={`Voices of staff ${staff.number}`}>
              {#each staff.voices as voice (voice.index)}
                <button
                  type="button"
                  class="chip"
                  aria-label={`Voice ${voice.index} of staff ${staff.number}`}
                  aria-pressed={staff.number === active.staff && voice.index === active.voice}
                  onclick={() => onlane({ staff: staff.number, voice: voice.index })}
                >{voice.index}</button>
              {/each}
            </div>
            {#if staffCount > 1 && part.staves.length > 1}
              <button
                type="button"
                class="btn"
                aria-label={`Remove staff ${staff.number}`}
                disabled={saving}
                onclick={() => askRemoveStaff(staff)}>Remove</button>
            {/if}
          </div>
          {#if confirming?.key === `staff-${staff.number}` || confirming?.key.startsWith(`voice-${staff.number}-`)}
            {@render confirmRow(confirming)}
          {/if}
          <div class="row">
            <select
              class="small-select"
              aria-label={`Opening clef of staff ${staff.number}`}
              value={staff.clef}
              disabled={saving}
              onchange={(event) => void run([setClefOp(staff, (event.currentTarget as HTMLSelectElement).value as Clef)])}
            >
              {#each CLEFS as clef (clef)}
                <option value={clef}>{clef}</option>
              {/each}
            </select>
          </div>
        </div>
      {/each}

      <div class="instrument">
        <input
          class="field"
          aria-label={`Name of part ${part.number}`}
          placeholder="Name, e.g. Piano"
          value={draftOf(part).name}
          oninput={(event) => setDraft(part, { name: (event.currentTarget as HTMLInputElement).value })}
        />
        <input
          class="field"
          aria-label={`Short name of part ${part.number}`}
          placeholder="Short name, e.g. Pno."
          value={draftOf(part).shortName}
          oninput={(event) => setDraft(part, { shortName: (event.currentTarget as HTMLInputElement).value })}
        />
        <div class="row">
          <input
            class="field"
            inputmode="numeric"
            aria-label={`MIDI program of part ${part.number}`}
            placeholder="program"
            value={draftOf(part).program}
            oninput={(event) => setDraft(part, { program: (event.currentTarget as HTMLInputElement).value })}
          />
          <input
            class="field"
            inputmode="numeric"
            aria-label={`Semitone shift of part ${part.number}`}
            placeholder="semitones"
            value={draftOf(part).transposition}
            oninput={(event) => setDraft(part, { transposition: (event.currentTarget as HTMLInputElement).value })}
          />
        </div>
        <div class="row">
          <button type="button" class="btn" disabled={saving} onclick={() => saveInstrument(part)}>Set instrument</button>
        </div>
        {#if instrumentError?.part === part.id}
          <p class="problem" role="alert">{instrumentError.text}</p>
        {/if}
      </div>
    </div>
  {/each}

  <div class="actions">
    <div class="row">
      <select class="small-select" aria-label="Clef for a new staff" bind:value={newClef}>
        {#each CLEFS as clef (clef)}
          <option value={clef}>{clef}</option>
        {/each}
      </select>
      <select class="small-select" aria-label="Type of a new staff" bind:value={newStaffType}>
        {#each STAFF_TYPES as type (type)}
          <option value={type}>{type}</option>
        {/each}
      </select>
      <button
        type="button"
        class="btn"
        disabled={saving || activePart === null}
        onclick={() => {
          if (activePart === null) return;
          const number = nextStaffNumberOf(activePart);
          void run([addStaffOp(activePart, newClef, newStaffType)], () => onlane({ staff: number, voice: 1 }));
        }}>New staff</button>
    </div>
    <div class="row">
      <button
        type="button"
        class="btn"
        disabled={saving || activeStaff === null || activeStaff.voices.length >= 4}
        onclick={() => {
          if (activeStaff === null) return;
          const next = [1, 2, 3, 4].find((index) => !activeStaff.voices.some((v) => v.index === index));
          void run([addVoiceOp(activeStaff)], () => {
            if (next !== undefined) onlane({ staff: activeStaff.number, voice: next });
          });
        }}>New voice</button>
      <button
        type="button"
        class="btn"
        disabled={saving || activeStaff === null || active.voice === 1}
        onclick={() => activeStaff !== null && askRemoveVoice(activeStaff, active.voice)}
      >Remove voice {active.voice}</button>
    </div>
    <div class="row">
      <input class="field" aria-label="Name of a new part" placeholder="New part name" bind:value={newPartName} />
      <select class="small-select" aria-label="Clef for a new part" bind:value={newPartClef}>
        {#each CLEFS as clef (clef)}
          <option value={clef}>{clef}</option>
        {/each}
      </select>
      <button
        type="button"
        class="btn"
        disabled={saving}
        onclick={() => {
          const number = staffCount + 1;
          void run([addPartOp(newPartName, newPartClef, newPartClef === 'percussion' ? 'percussion' : 'standard')], () => {
            newPartName = '';
            onlane({ staff: number, voice: 1 });
          });
        }}>New part</button>
    </div>
    {#if barNumber !== null && activeStaff !== null}
      <div class="row">
        <select class="small-select" aria-label={`Clef change from bar ${barNumber}`} bind:value={clefFrom}>
          {#each CLEFS as clef (clef)}
            <option value={clef}>{clef}</option>
          {/each}
        </select>
        <button
          type="button"
          class="btn"
          disabled={saving}
          onclick={() => activeStaff !== null && void run([setClefOp(activeStaff, clefFrom, barNumber)])}
        >Change clef at bar {barNumber}</button>
        <button
          type="button"
          class="btn"
          disabled={saving}
          onclick={() => activeStaff !== null && void run([setClefOp(activeStaff, null, barNumber)])}
        >Clear</button>
      </div>
    {/if}
  </div>

  {#if staffCount > 1}
    <div class="actions" role="group" aria-label="Move notes between staves">
      <span class="part-title">Move notes between staves</span>
      <div class="row">
        <input class="field" inputmode="numeric" aria-label="First bar to move" placeholder={barNumber === null ? 'from bar' : String(barNumber)} bind:value={moveFirst} />
        <input class="field" inputmode="numeric" aria-label="Last bar to move" placeholder={barNumber === null ? 'to bar' : String(barNumber)} bind:value={moveLast} />
      </div>
      <div class="row">
        <select class="small-select" aria-label="Move from staff" bind:value={moveFrom}>
          {#each parts.flatMap((part) => part.staves) as staff (staff.id)}
            <option value={staff.number}>staff {staff.number}</option>
          {/each}
        </select>
        <select class="small-select" aria-label="Move to staff" bind:value={moveTo}>
          {#each parts.flatMap((part) => part.staves) as staff (staff.id)}
            <option value={staff.number}>staff {staff.number}</option>
          {/each}
        </select>
      </div>
      <div class="row">
        <select class="small-select" aria-label="Which notes to move" bind:value={moveLimit}>
          <option value="all">every note</option>
          <option value="below">only notes below</option>
          <option value="above">only notes at or above</option>
        </select>
        {#if moveLimit !== 'all'}
          <input class="field" aria-label="Where the split falls" placeholder="C4" bind:value={movePitch} />
        {/if}
      </div>
      <div class="row">
        <button type="button" class="btn" disabled={saving} onclick={moveRange}>Move notes between staves</button>
      </div>
      {#if moveError !== null}
        <p class="problem" role="alert">{moveError}</p>
      {/if}
    </div>
  {/if}

  {#if error !== null}
    <p class="problem" role="alert">{error}</p>
  {/if}

  <p class="note">
    The active staff and voice are where a new note lands; pick them here or click the sheet. Keys 1 to 4 pick a voice of the
    active staff. Every change is a logged, undoable edit (<code>part|staff|voice add|rm</code>, <code>clef set</code>,
    <code>instrument set</code>). A clef change at a bar is stored; the engraving draws each staff's opening clef for now.
  </p>
</div>

{#snippet confirmRow(pending: { key: string; message: string; op: Operation })}
  <div class="confirm" role="alert">
    <span>{pending.message}</span>
    <div class="row">
      <button
        type="button"
        class="btn danger"
        disabled={saving}
        onclick={() => {
          const op = pending.op;
          confirming = null;
          void run([op]);
        }}>Remove with its music</button>
      <button type="button" class="btn" onclick={() => (confirming = null)}>Leave it</button>
    </div>
  </div>
{/snippet}

<style>
  .staves {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .active-line {
    margin: 0;
    font-size: 12px;
    color: var(--ink-soft);
  }
  .active-line b {
    color: var(--ink);
    font-weight: 600;
  }
  .part {
    display: flex;
    flex-direction: column;
    gap: 8px;
    border: 1px solid var(--rule);
    padding: 8px;
  }
  .part-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
    flex: 1;
  }
  .staff {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px;
    border-left: 2px solid transparent;
  }
  .staff.is-active {
    border-left-color: var(--accent);
    background: var(--panel-2);
  }
  .row {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .staff-pick {
    flex: 1;
    text-align: left;
    font: inherit;
    font-size: 12px;
    background: none;
    border: 0;
    padding: 2px 0;
    color: var(--ink);
    cursor: pointer;
  }
  .staff-pick[aria-pressed='true'] {
    font-weight: 600;
  }
  .chips {
    display: flex;
    gap: 3px;
  }
  .chip {
    font: inherit;
    font-size: 11.5px;
    min-width: 24px;
    padding: 2px 6px;
    border: 1px solid var(--rule);
    background: var(--panel-2);
    color: var(--ink-soft);
    cursor: pointer;
  }
  .chip[aria-pressed='true'] {
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 600;
  }
  .btn {
    font: inherit;
    font-size: 12px;
    border-radius: 6px;
    padding: 4px 10px;
    cursor: pointer;
    border: 1px solid var(--rule);
    background: transparent;
    color: var(--ink-soft);
  }
  .btn:hover:not(:disabled) {
    color: var(--ink);
    border-color: var(--ink-faint);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .btn.danger {
    color: var(--flag);
    border-color: var(--flag);
  }
  .field,
  .small-select {
    font: inherit;
    font-size: 12px;
    min-width: 0;
    flex: 1;
    box-sizing: border-box;
    background: var(--panel-2);
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 5px 7px;
  }
  .instrument {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .confirm {
    background: var(--flag-wash);
    border-left: 2px solid var(--flag);
    padding: 8px 10px;
    font-size: 12px;
    line-height: 1.5;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .problem {
    margin: 0;
    font-size: 12px;
    color: var(--flag);
  }
  .note {
    margin: 0;
    font-size: 11px;
    color: var(--ink-faint);
    line-height: 1.5;
  }
</style>
