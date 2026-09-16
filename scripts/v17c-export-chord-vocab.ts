/**
 * Export the character-level chord CTC vocabulary to a JSON manifest for the bespoke worker
 * (V17c, ADR-0031).
 *
 *   pnpm tsx scripts/v17c-export-chord-vocab.ts --out out/v17c/chord-vocab.json
 *
 * The Stage-2b chord model emits character class ids; the worker (Python) needs the same id -> symbol
 * table the TypeScript `buildChordVocabulary()` produced when the training corpus was dumped, so
 * `chord.onnx` and `chord-vocab.json` are a matched pair baked side by side (the `fetch_weights.py`
 * pattern, ADR-0024) — separate from Stage-2a's `model.onnx`/`vocab.json`, which share the bespoke
 * model dir. The vocabulary is closed and complete by construction and deterministic
 * (`packages/synth/src/chord-vocab.ts`), so regenerating it here yields byte-for-byte the manifest
 * `pnpm dump:v17b` wrote — no dependency on a gitignored corpus directory.
 *
 * The written shape matches the corpus's `vocab.json` exactly (`{ size, blank, sep, symbols }`), so the
 * worker reads one format whether it is handed a corpus or this export.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildChordVocabulary } from '@sibei/synth';

function parseOut(argv: string[]): string {
  const i = argv.indexOf('--out');
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : join('out', 'v17c', 'chord-vocab.json');
}

function main(): void {
  const out = parseOut(process.argv.slice(2));
  const vocab = buildChordVocabulary();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify({ size: vocab.size, blank: vocab.blank, sep: vocab.sep, symbols: vocab.symbols }, null, 2),
  );
  console.log(`wrote ${vocab.size} classes -> ${out}`);
}

main();
