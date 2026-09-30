import { formatKeySignature } from '@sibei/model';
import type { Id, Score } from '@sibei/model';
import type { StoredOperation } from '../ops/operations.js';
import type { ScoreListing } from './repository.js';

/**
 * The pieces of a score store that are the same whichever database holds it (V19, ADR-0034).
 *
 * Nothing here knows a driver exists — SQLite and Postgres are not named — so this file is not one of
 * the few `tests/arch` lets touch either. Sharing them is what stops the two adapters drifting on the
 * things a client can observe: how a listing row is derived, what a timestamp looks like, and what an
 * operation read back is.
 */

/**
 * The columns ADR-0006 extracts from the document for the library view. Derived on every write, so
 * they cannot drift from `doc` — which is the truth.
 */
export function listingColumns(score: Score): { title: string; composer: string; key: string } {
  return {
    title: score.meta.title,
    composer: score.meta.composer,
    key: formatKeySignature(score.meta.key),
  };
}

/** ISO-8601 to the second. Sortable as text, which is what the listing index relies on. */
export function timestamp(now: () => Date): string {
  return `${now().toISOString().slice(0, 19)}Z`;
}

/** A row of the library view, as either database returns it. */
export interface ListingRow {
  id: string;
  title: string;
  composer: string;
  key: string;
  updated_at: string;
  version: number;
}

export function toListing(row: ListingRow): ScoreListing {
  return {
    id: row.id,
    title: row.title,
    composer: row.composer,
    key: row.key,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

/** A row of the operation log, as either database returns it. */
export interface OperationRow {
  seq: number;
  batch: number;
  op_version: number;
  payload: string;
  created_at: string;
}

/**
 * The log row, back as an operation. The payload is *not* migrated on the way out: an old operation
 * shape must stay interpretable forever, because undo replays it (ADR-0028), so whatever was written
 * is what comes back.
 */
export function toStoredOperation(row: OperationRow): StoredOperation {
  return {
    seq: row.seq,
    batch: row.batch,
    version: row.op_version,
    operation: JSON.parse(row.payload) as StoredOperation['operation'],
    createdAt: row.created_at,
  };
}

/**
 * A document write with no operation behind it is the thing ADR-0003 forbids, so the store refuses it
 * rather than trusting every future caller to remember. The message is asserted in the conformance
 * suite, so the two adapters must agree on it.
 */
export function assertCarriesOperations(operations: readonly StoredOperation[]): void {
  if (operations.length === 0) {
    throw new Error('a write must carry the operations that caused it (ADR-0003)');
  }
}

export type { Id };
