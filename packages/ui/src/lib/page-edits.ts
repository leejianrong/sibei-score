import { PAGE_LIMITS_MM } from '@sibei/model';
import type { Score } from '@sibei/model';
import type { Operation } from './api.js';

/**
 * The page setup panel's edits (SIB2-287), the browser half of `sbscore page set`: one field's text to the `page.set` it
 * stands for, as pure data so a test can pin it without a DOM. Millimetres; blank clears the field back to the layout's
 * own default; the server judges the numbers again, this only refuses what is plainly not one.
 */

export type PageField = 'marginTop' | 'marginRight' | 'marginBottom' | 'marginLeft' | 'staffSize' | 'systemGap';

export const PAGE_FIELDS: readonly { field: PageField; label: string; range: readonly [number, number] }[] = [
  { field: 'staffSize', label: 'Staff size', range: PAGE_LIMITS_MM.staffSize },
  { field: 'systemGap', label: 'Space between systems', range: PAGE_LIMITS_MM.systemGap },
  { field: 'marginTop', label: 'Top margin', range: PAGE_LIMITS_MM.margin },
  { field: 'marginBottom', label: 'Bottom margin', range: PAGE_LIMITS_MM.margin },
  { field: 'marginLeft', label: 'Left margin', range: PAGE_LIMITS_MM.margin },
  { field: 'marginRight', label: 'Right margin', range: PAGE_LIMITS_MM.margin },
];

/** The value a field holds now, as the text the input shows ('' when the layout default applies). */
export function pageFieldText(score: Score, field: PageField): string {
  const page = score.meta.page;
  const value =
    field === 'staffSize' ? page?.staffSize
    : field === 'systemGap' ? page?.systemGap
    : page?.margin?.[field === 'marginTop' ? 'top' : field === 'marginRight' ? 'right' : field === 'marginBottom' ? 'bottom' : 'left'];
  return value === undefined ? '' : String(value);
}

export interface PageEdit {
  ok: boolean;
  error: string | null;
  /** Null when nothing changed (or the text is not sendable). */
  op: Operation | null;
}

export function pageSetOp(score: Score, field: PageField, text: string): PageEdit {
  const spec = PAGE_FIELDS.find((entry) => entry.field === field)!;
  const trimmed = text.trim();
  if (trimmed === pageFieldText(score, field)) return { ok: true, error: null, op: null };
  if (trimmed === '') return { ok: true, error: null, op: { type: 'page.set', payload: { [field]: null } } };
  const value = Number(trimmed);
  const [low, high] = spec.range;
  if (!Number.isFinite(value) || value < low || value > high) {
    return { ok: false, error: `${spec.label} is from ${low} to ${high} mm, or blank for the default.`, op: null };
  }
  return { ok: true, error: null, op: { type: 'page.set', payload: { [field]: value } } };
}
