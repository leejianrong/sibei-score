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
  /** A rate limit or a quota (V23): too fast, or too much. A script may back off on this and retry later. */
  limited: 9,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Kinds the server can answer with that map to `usage` (1) **on purpose**, and have since before this
 * list existed (KAN-612). `exitCodeForKind` falls through to 1 for anything it does not recognise, so
 * a kind added on the server silently became "usage" unless somebody remembered a case here;
 * `tests/arch/exit-code-kinds.test.ts` now reads the server's kinds out of its own source and fails
 * for any that is neither mapped above 1 nor named here. Naming a kind here is the act of deciding.
 *
 * SIB2-114 moved three off this list: `no-such-import` and `no-such-import-image` are not-found (5) and
 * `job-not-retryable` is validation (2), the class its audio sibling and `no-source-to-reparse` were
 * already in. A deliberate ADR-0008 contract change: a script that branched on 1 for these could only
 * be reading "something unanticipated", which is what 1 means; 5 and 2 say what happened.
 */
export const USAGE_KINDS: readonly string[] = [
  'internal',
  'unreadable-document',
  'method-not-allowed',
  'worker-unavailable',
  // The audio worker's protocol (SIB2-138). A pulling worker, not a person or the CLI, meets these: it
  // branches on them (lease-lost means abandon, invalid-result means do not retry), so none needs an exit
  // code of its own.
  'lease-lost',
  'bad-request',
  'invalid-result',
  // The browser's GitHub sign-in redirect flow (V20a, `/v1/auth/github/*`). A person's browser
  // meets these, not a CLI verb; `sbscore auth` (V21) will authenticate by device flow and token.
  'invalid-state',
  'missing-code',
  'sign-in-denied',
  'sign-in-failed',
  'github-unavailable',
  // The device-flow poll's two *expected* answers (V21a). `sbscore auth login` (V21b) loops on them and
  // never shows either to a person, so they have no exit code of their own to decide.
  'authorization-pending',
  'slow-down',
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
    // Audio jobs (SIB2-137): a too-large upload, a confirm before the bytes arrived, and a retry of a job
    // that is not failed are readable requests that cannot be fulfilled as asked.
    case 'audio-too-large':
    case 'audio-not-uploaded':
    case 'audio-job-not-retryable':
    case 'audio-gone': // retry refused, the audio is deleted: re-upload (SIB2-200); validation like its sibling
    case 'job-not-retryable': // an import job that is not failed (SIB2-114), the same class as the audio one
    // A NoteEvents file that is not valid v1 (ADR-0040): readable request, unusable content, never retryable.
    case 'invalid-note-events':
    // A MusicXML file that cannot be read (SIB2-152): malformed, too large, or an archive that holds none. The
    // sibling `unsupported-musicxml` (score-timewise) is covered by the `unsupported-` prefix above.
    case 'invalid-musicxml':
    // Photo import switched off on this service (SIB2-201): readable, never retryable, and the fix is to use
    // audio or a NoteEvents file. Validation like its siblings, so a script that backs off on 9 or retries on
    // 4 does neither.
    case 'photo-import-unavailable':
    // The device flow (V21a). A code that is not eight letters and digits, a scope that does not exist, and
    // a code that expired or was already used are requests that were readable and cannot be fulfilled: the
    // same class as `validation`, and the fix is to start again or correct the value.
    case 'invalid-code':
    case 'invalid-scopes':
    case 'expired-code':
    // Account deletion (V25): the login typed back did not match. Readable, not fulfilled, fix and retry.
    case 'confirmation-mismatch':
      return EXIT.validation;
    case 'no-such-score':
    case 'no-such-audio-job':
    case 'no-such-import': // SIB2-114: a job id the caller does not own is the same answer as one that is not there
    case 'no-such-import-image':
    case 'no-such-route':
    case 'not-found': // an unrouted /v1/auth/ path (V20a), the same fact as `no-such-route`
    case 'no-such-token': // V21a: another user's token and a missing one are the same answer
    case 'unknown-code': // V21a: a user code that is not waiting for approval
      return EXIT.notFound;
    case 'conflict-exists':
      return EXIT.exists;
    case 'foreign-origin':
    case 'foreign-host':
    case 'forbidden': // SIB2-138: a user credential on the worker routes, or a worker credential anywhere else
    case 'unauthenticated':
    case 'insufficient-scope': // V21a: a token that lacks the scope for what it asked to do
    case 'wrong-audience': // V22a: an MCP token presented at the /v1/ API
      return EXIT.refused;
    case 'rate-limited': // V23: too fast; wait for Retry-After
    case 'quota-exceeded': // V23: too much; delete something or wait for the daily window
      return EXIT.limited;
    default:
      return EXIT.usage;
  }
}
