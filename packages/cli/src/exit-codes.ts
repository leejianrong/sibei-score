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
      return EXIT.validation;
    case 'no-such-score':
    case 'no-such-route':
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
