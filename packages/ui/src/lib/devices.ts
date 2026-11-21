import { ApiError } from './api.js';

/**
 * The browser's side of approving a device (V21b): what a person types into the code field, and what to
 * say when the server refuses it. Plain TypeScript so both can be tested without a browser.
 *
 * **The server owns what a code is.** Nothing here knows the alphabet the server draws codes from; it only
 * shapes what was typed into the form a person would read from a terminal (`BCDF-GHJK`) and notices when
 * there are plainly not eight characters, so a mistyped code is caught in the field instead of costing a
 * round trip. Whether the eight characters name a code that is waiting is the server's answer alone, and
 * it answers "unknown", "expired" and "already used" the same way on purpose.
 */

export const CODE_LENGTH = 8;

/** What is typed, as the field shows it: upper case, letters and digits only, a dash after the fourth. */
export function formatTypedCode(typed: string): string {
  const cleaned = typed.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
  return cleaned.length > 4 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : cleaned;
}

/** Whether there are enough characters to be worth sending. */
export function isCompleteCode(typed: string): boolean {
  return typed.replace(/[^A-Za-z0-9]/g, '').length === CODE_LENGTH;
}

/** The scopes a token may carry, with what each lets a device do, in the words the form shows. */
export const SCOPE_CHOICES = [
  { scope: 'read', label: 'Read your charts' },
  { scope: 'write', label: 'Change your charts' },
] as const;

export type ScopeName = (typeof SCOPE_CHOICES)[number]['scope'];

/** How a token's scope reads in the token list. An MCP client's scopes are named in words; an unknown one stays raw. */
export function scopeLabel(scope: string): string {
  switch (scope) {
    case 'read':
      return 'Read charts';
    case 'write':
      return 'Change charts';
    case 'mcp:read':
      return 'Read charts (MCP)';
    case 'mcp:write':
      return 'Change charts (MCP)';
    default:
      return scope;
  }
}

/**
 * What a CLI asked for in the approval link (`#/device?scopes=read&name=ci`): pre-filled values only, validated
 * against the choices the form offers; anything else is ignored, and the person can change all of it.
 */
export function prefillOf(hash: string): { name?: string; scopes?: ScopeName[] } {
  const query = hash.split('?')[1] ?? '';
  const params = new URLSearchParams(query);
  const out: { name?: string; scopes?: ScopeName[] } = {};
  const name = params.get('name')?.trim().slice(0, 60);
  if (name) out.name = name;
  const asked = (params.get('scopes') ?? '').split(',');
  const scopes = SCOPE_CHOICES.map((c) => c.scope).filter((s) => asked.includes(s));
  if (scopes.length > 0) out.scopes = scopes;
  return out;
}

/** The scopes still on after one is toggled, in a stable order. At least one always stays on. */
export function toggleScope(on: readonly ScopeName[], scope: ScopeName): ScopeName[] {
  const next = on.includes(scope) ? on.filter((s) => s !== scope) : [...on, scope];
  if (next.length === 0) return [...on];
  return SCOPE_CHOICES.map((c) => c.scope).filter((s) => next.includes(s));
}

/**
 * A day as a person reads it in a token list: `12 Oct 2026`. UTC, so the date a token expires is the same
 * date in every timezone and the same one `sbscore auth status` prints.
 */
export function formatDay(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(at);
}

export type Outcome =
  | { kind: 'approved' }
  | { kind: 'not-waiting' }
  | { kind: 'refused'; message: string };

/**
 * What an approval's failure means for the person looking at it. A `404 unknown-code` is the expected way
 * for this to go wrong (a typo, an expired code, one already used), so it is a message about the code, not
 * an error screen. Anything else is passed through in the server's own words.
 */
export function outcomeOfFailure(error: unknown): Outcome | null {
  if (!(error instanceof ApiError)) return null;
  if (error.kind === 'unknown-code') return { kind: 'not-waiting' };
  return { kind: 'refused', message: error.message };
}
