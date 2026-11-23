<script lang="ts">
  /**
   * The note-input keypad (SIB2-155): the on-screen twin of the keyboard map in `../lib/note-input.ts`, so a mouse
   * user has every control a keyboard user has and the keys are printed where the eye looks for them.
   *
   * It builds nothing. A press hands `ScoreView` an `InputAction`, the same one the key handler produces, and the
   * step it runs turns it into ordinary ops (`note.add`, `rest.add`, `note.rm`, `note.set`, `bar.add`).
   */
  import type { Step } from '@sibei/model';
  import { DURATION_KEYS } from '../lib/note-input.js';
  import type { InputAction } from '../lib/note-input.js';

  interface Props {
    /** `bar 3 · beat 2`. */
    where: string;
    /** `Staff 2 · bass · Voice 2`, or null on a one-lane chart. */
    laneText: string | null;
    value: number;
    dots: number;
    pendingAlter: number | null;
    tieNext: boolean;
    atEnd: boolean;
    voices: number[];
    voice: number;
    message: string | null;
    error: string | null;
    saving: boolean;
    onaction: (action: InputAction) => void;
  }

  const { where, laneText, value, dots, pendingAlter, tieNext, atEnd, voices, voice, message, error, saving, onaction }: Props = $props();

  const LETTERS: readonly Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const ACCIDENTAL_LABEL: Record<string, string> = { '-2': '𝄫', '-1': '♭', '0': '♮', '1': '♯', '2': '𝄪' };

  /** A keypad press: act, then give the focus back to the page so the next key is a note, not a click on this button. */
  function press(event: MouseEvent, action: InputAction): void {
    onaction(action);
    (event.currentTarget as HTMLElement).blur();
  }
</script>

<div class="note-input" role="group" aria-label="Note input keypad" data-testid="note-input-panel">
  <div class="head">
    <span class="mode">Note input</span>
    <span class="where" data-testid="note-input-caret">{atEnd ? 'end of the chart' : where}</span>
    {#if laneText !== null}<span class="lane">{laneText}</span>{/if}
    <button type="button" class="done" aria-label="Leave note input" onclick={(event) => press(event, { type: 'exit' })}>
      Done <kbd>Esc</kbd>
    </button>
  </div>

  <div class="pads">
    <div class="pad" role="group" aria-label="Note value">
      {#each DURATION_KEYS as entry (entry.key)}
        <button
          type="button"
          class="key"
          class:on={value === entry.value}
          aria-pressed={value === entry.value}
          aria-label="{entry.label} note"
          onclick={(event) => press(event, { type: 'duration', value: entry.value })}
        >
          <kbd>{entry.key}</kbd><span>{entry.label}</span>
        </button>
      {/each}
      <button type="button" class="key" class:on={dots > 0} aria-pressed={dots > 0} aria-label="Dotted" onclick={(event) => press(event, { type: 'dot' })}>
        <kbd>.</kbd><span>Dot</span>
      </button>
    </div>

    <div class="pad" role="group" aria-label="Letter names">
      {#each LETTERS as step (step)}
        <button type="button" class="key letter" aria-label="Enter {step}" onclick={(event) => press(event, { type: 'pitch', step, add: false })}>
          <kbd>{step.toLowerCase()}</kbd><span>{step}</span>
        </button>
      {/each}
      <button type="button" class="key" aria-label="Rest" onclick={(event) => press(event, { type: 'rest' })}><kbd>r</kbd><span>Rest</span></button>
    </div>

    <div class="pad" role="group" aria-label="Edit the last note">
      <button type="button" class="key" aria-label="Raise by a semitone" onclick={(event) => press(event, { type: 'accidental', delta: 1 })}><kbd>+</kbd><span>♯</span></button>
      <button type="button" class="key" aria-label="Lower by a semitone" onclick={(event) => press(event, { type: 'accidental', delta: -1 })}><kbd>-</kbd><span>♭</span></button>
      <button type="button" class="key" aria-label="Natural" onclick={(event) => press(event, { type: 'accidental', delta: 0 })}><kbd>0</kbd><span>♮</span></button>
      <button type="button" class="key" class:on={tieNext} aria-pressed={tieNext} aria-label="Tie to the next note" onclick={(event) => press(event, { type: 'tie' })}><kbd>t</kbd><span>Tie</span></button>
      <button type="button" class="key" aria-label="Move the last note up a step" onclick={(event) => press(event, { type: 'shift', steps: 1 })}><kbd>↑</kbd><span>Up</span></button>
      <button type="button" class="key" aria-label="Move the last note down a step" onclick={(event) => press(event, { type: 'shift', steps: -1 })}><kbd>↓</kbd><span>Down</span></button>
    </div>

    <div class="pad" role="group" aria-label="Caret">
      <button type="button" class="key" aria-label="Caret back" onclick={(event) => press(event, { type: 'move', direction: -1 })}><kbd>←</kbd><span>Back</span></button>
      <button type="button" class="key" aria-label="Caret forward" onclick={(event) => press(event, { type: 'move', direction: 1 })}><kbd>→</kbd><span>Forward</span></button>
      <button type="button" class="key" aria-label={atEnd ? 'Add a bar here' : 'Skip a beat'} onclick={(event) => press(event, { type: 'advance' })}>
        <kbd>Enter</kbd><span>{atEnd ? 'Add bar' : 'Skip'}</span>
      </button>
      <button type="button" class="key" aria-label="Delete the previous note" onclick={(event) => press(event, { type: 'back' })}><kbd>⌫</kbd><span>Delete</span></button>
    </div>

    {#if voices.length > 1}
      <div class="pad" role="group" aria-label="Caret voice">
        {#each voices as number (number)}
          <button
            type="button"
            class="key"
            class:on={voice === number}
            aria-pressed={voice === number}
            aria-label="Caret voice {number}"
            onclick={(event) => press(event, { type: 'voice', voice: number })}
          >
            <kbd>Ctrl+Alt+{number}</kbd><span>Voice {number}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <p class="hint">
    <kbd>⇧</kbd>+letter adds a pitch to the chord · <kbd>↑</kbd><kbd>↓</kbd> move the last note a step, with <kbd>Ctrl</kbd> an octave ·
    <kbd>+</kbd><kbd>-</kbd> change its accidental (before a note: the next one){pendingAlter === null ? '' : ` · next note: ${ACCIDENTAL_LABEL[String(pendingAlter)] ?? ''}`}
    · <kbd>?</kbd> all shortcuts
  </p>
  {#if error !== null}<p class="problem" role="alert">{error}</p>
  {:else if message !== null}<p class="message" role="status">{message}</p>
  {/if}
  {#if saving}<span class="working" aria-hidden="true"></span>{/if}
</div>

<style>
  .note-input {
    position: sticky;
    top: var(--top-h);
    z-index: 5;
    width: 100%;
    box-sizing: border-box;
    margin-bottom: 18px;
    padding: 10px 14px 10px;
    background: var(--panel);
    border: 1px solid var(--accent);
    border-radius: 8px;
    box-shadow: var(--sheet-shadow);
    display: flex;
    flex-direction: column;
    gap: 8px;
    letter-spacing: normal;
    color: var(--ink);
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 12px;
    font-size: 12px;
  }
  .mode {
    font-weight: 600;
    color: var(--accent);
  }
  .where {
    font-variant-numeric: tabular-nums;
    color: var(--ink);
  }
  .lane {
    color: var(--ink-faint);
  }
  .done {
    margin-left: auto;
  }
  .pads {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 18px;
  }
  .pad {
    display: flex;
    gap: 4px;
  }
  .key,
  .done {
    font: inherit;
    font-size: 11px;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    min-width: 40px;
    padding: 3px 6px;
    border-radius: 6px;
    border: 1px solid var(--rule);
    background: transparent;
    color: var(--ink-soft);
    cursor: pointer;
  }
  .done {
    flex-direction: row;
    gap: 6px;
    padding: 3px 10px;
  }
  .key:hover,
  .done:hover {
    color: var(--ink);
    border-color: var(--ink-faint);
  }
  .key.on {
    background: var(--accent-wash);
    border-color: var(--accent);
    color: var(--ink);
  }
  .key.letter span {
    font-weight: 600;
  }
  kbd {
    font: inherit;
    font-size: 10px;
    color: var(--ink-faint);
    border: 1px solid var(--rule);
    border-radius: 3px;
    padding: 0 4px;
    line-height: 14px;
    background: var(--panel-2);
  }
  .hint,
  .message,
  .problem {
    margin: 0;
    font-size: 11px;
    line-height: 1.6;
    color: var(--ink-faint);
  }
  .hint kbd {
    margin: 0 1px;
  }
  .message {
    color: var(--ink-soft);
  }
  .problem {
    color: var(--flag);
  }
  .working {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
</style>
