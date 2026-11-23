<script lang="ts">
  /**
   * Page setup (SIB2-287): the staff size, the space between systems and the four margins, in millimetres. The browser
   * half of `sbscore page set`. A field commits when it loses focus or Enter is pressed; blank restores the layout's own
   * default (shown as the placeholder). Each commit is one logged, undoable `page.set`, and the sheet repaints through the
   * same `layout()` the PDF uses, so what changes here is what prints.
   */
  import { PAGE_DEFAULTS_MM } from '@sibei/model';
  import type { Score } from '@sibei/model';
  import type { Operation } from '../lib/api.js';
  import { PAGE_FIELDS, pageFieldText, pageSetOp } from '../lib/page-edits.js';
  import type { PageField } from '../lib/page-edits.js';

  interface Props {
    score: Score;
    saving: boolean;
    onops: (operations: Operation[]) => Promise<boolean>;
  }

  const { score, saving, onops }: Props = $props();

  let drafts = $state<Partial<Record<PageField, string>>>({});
  let problem = $state<string | null>(null);
  // A change to the chart (an undo, another surface) drops what was half typed.
  $effect(() => {
    void score;
    drafts = {};
    problem = null;
  });

  const placeholder = (field: PageField): string =>
    String(
      field === 'staffSize' ? PAGE_DEFAULTS_MM.staffSize
      : field === 'systemGap' ? PAGE_DEFAULTS_MM.systemGap
      : PAGE_DEFAULTS_MM.margin[field === 'marginTop' ? 'top' : field === 'marginRight' ? 'right' : field === 'marginBottom' ? 'bottom' : 'left'],
    );

  async function commit(field: PageField): Promise<void> {
    const text = drafts[field] ?? pageFieldText(score, field);
    const edit = pageSetOp(score, field, text);
    if (!edit.ok) {
      problem = edit.error;
      return;
    }
    problem = null;
    if (edit.op !== null) await onops([edit.op]);
  }
</script>

<div class="page-setup">
  {#each PAGE_FIELDS as spec (spec.field)}
    <label class="ps-field">
      <span>{spec.label} (mm)</span>
      <input
        type="text"
        inputmode="decimal"
        placeholder={placeholder(spec.field)}
        value={drafts[spec.field] ?? pageFieldText(score, spec.field)}
        disabled={saving}
        oninput={(event) => (drafts = { ...drafts, [spec.field]: (event.currentTarget as HTMLInputElement).value })}
        onchange={() => void commit(spec.field)}
        onkeydown={(event) => {
          if (event.key === 'Enter') void commit(spec.field);
        }}
      />
    </label>
  {/each}
  {#if problem !== null}<p class="problem" role="alert">{problem}</p>{/if}
  <p class="note">
    The whole page scales with the staff size, text included. Blank is the default. A logged, undoable edit (<code>page set</code>).
  </p>
</div>

<style>
  .page-setup {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .ps-field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-soft);
  }
  .ps-field input {
    font: inherit;
    font-size: 12px;
    letter-spacing: 0;
    text-transform: none;
    color: var(--ink);
    background: var(--panel-2);
    border: 1px solid var(--rule);
    padding: 7px 9px;
    min-height: 32px;
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
  }
  .ps-field input:focus {
    border-color: var(--accent);
    outline: none;
  }
  .problem,
  .note {
    grid-column: 1 / -1;
    margin: 0;
    font-size: 12px;
    color: var(--ink-soft);
  }
  .problem {
    color: var(--error, #b00020);
  }
</style>
