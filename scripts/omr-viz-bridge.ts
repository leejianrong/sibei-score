/**
 * A read-only bridge from the dev-only OMR pipeline viewer (`worker/devtools/omr_viz`, EPIC-228,
 * KAN-1508 Milestone D) into the TypeScript-side import stages. `indah` is Python-only, and
 * `mapOmrToScore`/`correctChord`/Stage-3 beat mapping are real TypeScript the viewer must show
 * running for real (ADR-0005) — never a Python reimplementation that could drift from the actual
 * mapper. This is the "small tsx script that dumps intermediate JSON" the KAN-1508 card describes.
 *
 *   pnpm omr-viz-bridge <path-to-OmrDocument.json>
 *
 * Reads one `OmrDocument` (the exact JSON `sibei_omr.engines.bespoke.recognize` — or any engine —
 * emits) and prints one JSON object to stdout:
 *
 *   - `mapOnly`: `mapOmrToScore` with no corrector — the "Map" stage alone (V11): bars, onsets and
 *     pitch from staff geometry, no chords. This is also exactly what a pure-model caller gets.
 *   - `final`: `mapOmrToScore` with `correctChord` injected — Map + the V5 grammar corrector +
 *     Stage-3 beat mapping together, the real import result.
 *   - `corrections`: every raw `bandTokens[].text` run through `correctChord` directly, independent
 *     of which bar it lands in — the grammar stage in isolation, "before" (OCR text) next to
 *     "after" (the canonical chord spelling, or `null` when it is not a legal chord and would import
 *     as a flagged annotation instead).
 *
 * A document with no staff throws `OmrMappingError` (ADR-0018/Q28) — a real, user-facing outcome
 * this bridge surfaces as a clean stderr message and a non-zero exit, not a stack trace, so the
 * viewer can show it rather than crash.
 *
 * Dev-only: not imported by any package, not part of the product runtime, not in CI beyond
 * typecheck — same posture as `scripts/eval.ts` and `scripts/v16a-dump-detect-corpus.ts`.
 */

import { readFileSync } from 'node:fs';
import { mapOmrToScore, parseOmrDocument } from '@sibei/model';
import { correctChord } from '@sibei/music';

function main(): void {
  const path = process.argv[2];
  if (path === undefined) {
    throw new Error('usage: pnpm omr-viz-bridge <path-to-OmrDocument.json>');
  }
  const doc = parseOmrDocument(JSON.parse(readFileSync(path, 'utf8')));
  const id = 'omr-viz-bridge';

  const mapOnly = mapOmrToScore([doc], { id });
  const final = mapOmrToScore([doc], { id }, correctChord);
  const corrections = doc.bandTokens
    .map((token) => ({ text: token.text, corrected: correctChord(token.text.trim()) }))
    .filter((c) => c.text.trim() !== '');

  process.stdout.write(JSON.stringify({ mapOnly, final, corrections }));
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
}
