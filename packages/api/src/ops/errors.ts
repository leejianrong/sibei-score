import type { AddressFailure } from '@sibei/model';
import { formatAddressFailure } from '@sibei/model';

/**
 * Why an operation was refused.
 *
 * Structured, and the distinctions are the ones a caller branches on: the API maps them to
 * status codes and the CLI to exit codes, and ADR-0008 requires those to be distinct enough to
 * branch on *without parsing prose*. "Your patch is invalid" is the failure mode this exists to
 * avoid — the difference between an agent that self-corrects and one that retries blind.
 */
export type OperationFailure =
  /** The address did not resolve. Carries the resolver's own structured reason (ADR-0007). */
  | { kind: 'address'; failure: AddressFailure }
  /** The payload was not usable: a bad pitch, a duration that is not a note value. */
  | { kind: 'validation'; detail: string }
  /** A verb this build does not know. */
  | { kind: 'unknown-operation'; type: string }
  /** The operation needs a target and did not carry one, or carried one it cannot use. */
  | { kind: 'bad-target'; type: string; detail: string }
  /** A create whose id is taken, or a create on a score that already exists. */
  | { kind: 'conflict-exists'; id: string }
  /** Everything but a create needs a score to act on. */
  | { kind: 'no-such-score'; id: string }
  /**
   * A stale write (ADR-0003). Carries the current version so the client can re-read and retry.
   * Not last-write-wins: silently destroying the other party's edit is much worse when the
   * other party is an agent working unattended.
   */
  | { kind: 'stale-version'; expected: number; current: number }
  /** A create must be the first operation on a score, and only a create may be. */
  | { kind: 'bad-first-operation'; detail: string };

export class OperationError extends Error {
  readonly failure: OperationFailure;
  /** Which operation in a batch failed, 0-based. Absent when the batch itself was the problem. */
  readonly index: number | undefined;

  constructor(failure: OperationFailure, index?: number) {
    super(describeOperationFailure(failure, index));
    this.name = 'OperationError';
    this.failure = failure;
    this.index = index;
  }
}

export function describeOperationFailure(failure: OperationFailure, index?: number): string {
  const where = index === undefined ? '' : `operation ${index + 1}: `;
  return `${where}${body(failure)}`;
}

function body(failure: OperationFailure): string {
  switch (failure.kind) {
    case 'address':
      return formatAddressFailure(failure.failure);
    case 'validation':
      return failure.detail;
    case 'unknown-operation':
      return `no such operation: ${JSON.stringify(failure.type)}`;
    case 'bad-target':
      return `${failure.type} ${failure.detail}`;
    case 'conflict-exists':
      return `a score with the id ${JSON.stringify(failure.id)} already exists`;
    case 'no-such-score':
      return `there is no score with the id ${JSON.stringify(failure.id)}`;
    case 'stale-version':
      return (
        `the score is at version ${failure.current}, not ${failure.expected}. ` +
        `Re-read it and retry.`
      );
    case 'bad-first-operation':
      return failure.detail;
  }
}
