/**
 * Export the flat-semantic CTC vocabulary to a JSON manifest for the bespoke worker (V15c, ADR-0031).
 *
 *   pnpm tsx scripts/v15c-export-vocab.ts --out out/v15b/vocab.json
 *
 * The Stage-2a model emits class ids; the worker (Python) needs the same id -> symbol table the
 * TypeScript `buildVocabulary()` produced when the training corpus was dumped, so `model.onnx` and
 * `vocab.json` are a matched pair baked side by side (the `fetch_weights.py` pattern, ADR-0024). The
 * vocabulary is closed and complete by construction and deterministic (`packages/synth/src/vocab.ts`),
 * so regenerating it here yields byte-for-byte the manifest `pnpm dump:v15a` wrote — this is the
 * "small export step" the V15c plan calls for, avoiding a dependency on a gitignored corpus directory.
 *
 * The written shape matches the corpus's `vocab.json` exactly (`{ size, blank, symbols }`), so the
 * worker reads one format whether it is handed a corpus or this export.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildVocabulary } from '@sibei/synth';

function parseOut(argv: string[]): string {
  const i = argv.indexOf('--out');
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : join('out', 'v15b', 'vocab.json');
}

function main(): void {
  const out = parseOut(process.argv.slice(2));
  const vocab = buildVocabulary();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ size: vocab.size, blank: 0, symbols: vocab.symbols }, null, 2));
  console.log(`wrote ${vocab.size} classes -> ${out}`);
}

main();
