/**
 * Exit codes (ADR-0008).
 *
 * "Exit codes are distinct enough to branch on without parsing prose" — separate codes for a
 * stale-version conflict, an invalid address, and a validation failure. An agent driving this with no
 * human in the loop should be able to tell "you addressed the wrong thing" from "somebody else edited
 * it, re-read and retry" from "the server is not running", and take a different action for each.
 *
 * These are a contract. Adding one is fine; changing what an existing number means breaks every
 * script anybody wrote.
 */
export const EXIT = {
  ok: 0,
  /** Bad usage, or something this build did not anticipate. */
  usage: 1,
  /** The payload was not usable: a bad pitch, a duration that is not a note value. */
  validation: 2,
  /** The address did not resolve. The message lists the bar's real onsets. */
  address: 3,
  /** A stale expected version. Re-read at the version in the message and retry (ADR-0003). */
  conflict: 4,
  /** No such score. */
  notFound: 5,
  /** The server is not running, or not reachable. A real cost of ADR-0002, which the ADR names. */
  noServer: 6,
  /** Refused at the boundary: a foreign Origin or Host (ADR-0029). */
  refused: 7,
  /** A score with that id already exists. */
  exists: 8,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Kinds the server can answer with that map to `usage` (1) **on purpose**, and have since before this
 * list existed (KAN-612). `exitCodeForKind` falls through to 1 for anything it does not recognise, so
 * a kind added on the server silently became "usage" unless somebody remembered a case here;
 * `tests/arch/exit-code-kinds.test.ts` now reads the server's kinds out of its own source and fails
 * for any that is neither mapped above 1 nor named here. Naming a kind here is the act of deciding.
 *
 * Several of these arguably deserve a better number (`no-such-import` is a not-found;
 * `job-not-retryable` is the same class as `no-source-to-reparse`). Moving one changes what a script
 * sees, which ADR-0008 forbids doing in passing, so they are recorded as they behave today.
 */
export const USAGE_KINDS: readonly string[] = [
  'internal',
  'unreadable-document',
  'method-not-allowed',
  'no-such-import',
  'no-such-import-image',
  'job-not-retryable',
  'worker-unavailable',
  // The browser's GitHub sign-in redirect flow (V20a, `/v1/auth/github/*`). A person's browser
  // meets these, not a CLI verb; `sbscore auth` (V21) will authenticate by device flow and token.
  'invalid-state',
  'missing-code',
  'sign-in-denied',
  'sign-in-failed',
  'github-unavailable',
];

/** Kind families built from a template on the server (`bad-upload-${reason}`), matched by prefix. */
export const USAGE_KIND_PREFIXES: readonly string[] = ['bad-upload-'];

/**
 * The server's error `kind` to an exit code. One place, so the CLI and the API cannot drift about
 * what a failure *is* — they already agree about the message, because the server sends it.
 */
export function exitCodeForKind(kind: string): ExitCode {
  // Every `unsupported-<parameter>` the export route can answer with — format, instrument, paper,
  // font — is a 422 of the same class as a validation failure: the request was readable, the
  // content could not be produced, and the message carries the list of what can. Matched by prefix
  // rather than a case per parameter, so a parameter added server-side lands on 2 and not on 1.
  if (kind.startsWith('unsupported-')) return EXIT.validation;

  switch (kind) {
    case 'stale-version':
      return EXIT.conflict;
    case 'address':
      return EXIT.address;
    case 'validation':
    case 'unknown-operation':
    case 'bad-target':
    case 'bad-first-operation':
    // 2 and not 4 (KAN-607). 4 means "somebody else edited it, re-read and retry", and a script
    // branching on 4 will retry — which is exactly the wrong response to a request that named no
    // version, because retrying it unchanged cannot ever succeed. This is a malformed write.
    case 'missing-expected-version':
    case 'malformed-json':
    case 'body-too-large':
    // A re-parse of a chart with no scan behind it (V14e): the request was readable, there is simply
    // nothing to re-run — the same "readable, cannot be produced" class as an unsupported export value.
    case 'no-source-to-reparse':
      return EXIT.validation;
    case 'no-such-score':
    case 'no-such-route':
    case 'not-found': // an unrouted /v1/auth/ path (V20a), the same fact as `no-such-route`
      return EXIT.notFound;
    case 'conflict-exists':
      return EXIT.exists;
    case 'foreign-origin':
    case 'foreign-host':
    case 'unauthenticated':
      return EXIT.refused;
    default:
      return EXIT.usage;
  }
}
