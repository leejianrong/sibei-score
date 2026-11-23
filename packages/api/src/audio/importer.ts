import { OperationError } from '../ops/errors.js';
import type { ScoreImporter } from '../imports/runner.js';
import { checkNoteEventsInput, mapNoteEventsDocuments } from '../imports/note-events.js';
import type { AudioResultImporter } from './worker-service.js';

/**
 * The join between a completed audio job and an editable draft (SIB2-E10, ADR-0040).
 *
 * `complete` hands the stored NoteEvents result here. It is validated by the same v1 check the upload
 * boundary uses (a refusal fails the job, non-retryable, and writes nothing), mapped by the pure mapper,
 * and landed through the applier's server-only `import` under the job's owner (ADR-0003, ADR-0008) as a
 * score id derived from the job id, so a re-delivered `complete` lands the same draft rather than a second.
 * The engine's and quantizer's warnings come back as the job's diagnostic.
 *
 * The duration cross-check (ADR-0034 decision 17) is advisory: the length the document says it covers,
 * the length the worker says it decoded, and the length the uploader declared should agree, and when they
 * do not by more than the tolerance that is a warning on the draft, never a rejection.
 */

/** Disagreement tolerated before it is worth a warning: the larger of this many seconds and 5%. */
export const DURATION_TOLERANCE_SECONDS = 1;
export const DURATION_TOLERANCE_FRACTION = 0.05;

export function createAudioResultImporter(options: { applier: ScoreImporter }): AudioResultImporter {
  return {
    async importResult(job, noteEvents) {
      const checked = checkNoteEventsInput(noteEvents);
      if (!checked.ok) return { ok: false, kind: 'invalid-result', message: checked.message };

      const { score, diagnostics } = mapNoteEventsDocuments(checked.documents, { id: `audio-${job.id}` });
      const warnings = [...diagnostics];
      const covered = checked.document.source.duration_s;
      for (const [label, other] of [
        ['the worker decoded', job.durationSeconds],
        ['the upload declared', job.declaredDurationSeconds],
      ] as const) {
        if (other !== null && Math.abs(other - covered) > Math.max(DURATION_TOLERANCE_SECONDS, DURATION_TOLERANCE_FRACTION * other)) {
          warnings.push(`duration-mismatch: the transcription covers ${round(covered)}s but ${label} ${round(other)}s`);
        }
      }

      try {
        await options.applier.import(job.owner, score);
      } catch (error) {
        // A redelivered `complete` finds the draft already there: that is success, not a conflict.
        if (!(error instanceof OperationError && error.failure.kind === 'conflict-exists' && error.failure.id === score.id)) throw error;
      }
      return { ok: true, scoreId: score.id, diagnostic: warnings.length === 0 ? null : warnings.join('\n') };
    },
  };
}

const round = (n: number): number => Math.round(n * 10) / 10;
