/**
 * The evaluation harness core: generate a corpus, run a recogniser over it, score each chart, and
 * aggregate. This is the measurement R6 asks for (ADR-0020) — the table `make eval` prints and the
 * gate v0.3's engine swap is decided on (ADR-0031).
 *
 * The recogniser is *injected* (`Predict`), for two reasons. It keeps this pure of transport and
 * therefore testable without oemer (a fake predictor exercises the whole pipeline deterministically),
 * and it is the seam the two engines plug into — `scripts/eval.ts` supplies an HTTP-worker predictor
 * over oemer today, and a bespoke one later, without this file changing (ADR-0005). The harness is
 * also fs-free: it works in memory and returns a report; writing the corpus, the table and the
 * per-run history to disk is the script's job.
 */

import type { Score } from '@sibei/model';
import { makeRng } from '../rng.js';
import { generateScore } from '../generate.js';
import type { AggregateMetrics, OmrMetrics } from '../metrics.js';
import { aggregate, scoreOmr } from '../metrics.js';
import type { DegradeLevel } from './degrade.js';
import { degradationPreset, degrade } from './degrade.js';
import { renderScoreToPng } from './rasterize.js';

export interface CorpusSpec {
  /** Reproducibility: the chart, its rendering and its degradation all derive from this. */
  seed: number;
  bars: number;
  level: DegradeLevel;
}

export interface EntryResult {
  spec: CorpusSpec;
  format: 'png' | 'jpeg';
  metrics: OmrMetrics;
}

/**
 * Recognise an image into a `Score`. Real implementations take only the bytes and format; `spec` is
 * passed for provenance and to let a test-fake be deterministic — a real predictor ignores it.
 */
export type Predict = (image: Buffer, format: 'png' | 'jpeg', spec: CorpusSpec) => Promise<Score>;

export interface EvalReport {
  entries: EntryResult[];
  /** Aggregated metrics per degradation level — the rows of the printed table. */
  byLevel: Partial<Record<DegradeLevel, AggregateMetrics>>;
}

export interface RunEvalOptions {
  /** Render scale for the corpus images (default 2 — near phone-photo resolution). */
  zoom?: number;
}

/** A degradation rng seed that is stable per (chart, level) but differs between them. */
const LEVEL_INDEX: Record<DegradeLevel, number> = { clean: 0, light: 1, medium: 2, heavy: 3 };
function degradeSeed(spec: CorpusSpec): number {
  return spec.seed * 100 + LEVEL_INDEX[spec.level];
}

/** Generate the corpus for one spec: the ground-truth score and its degraded image. */
export async function buildEntry(
  spec: CorpusSpec,
  options: RunEvalOptions = {},
): Promise<{ truth: Score; image: Buffer; format: 'png' | 'jpeg' }> {
  const truth = generateScore({ seed: spec.seed, bars: spec.bars });
  const clean = renderScoreToPng(truth, { zoom: options.zoom ?? 2 })[0] as Buffer;
  const degraded = await degrade(clean, degradationPreset(spec.level), makeRng(degradeSeed(spec)));
  return { truth, image: degraded.data, format: degraded.format };
}

/** Run the whole corpus through a predictor, score each chart, and aggregate by level. */
export async function runEval(
  specs: readonly CorpusSpec[],
  predict: Predict,
  options: RunEvalOptions = {},
): Promise<EvalReport> {
  const entries: EntryResult[] = [];
  for (const spec of specs) {
    const { truth, image, format } = await buildEntry(spec, options);
    const predicted = await predict(image, format, spec);
    entries.push({ spec, format, metrics: scoreOmr(predicted, truth) });
  }

  const byLevel: Partial<Record<DegradeLevel, AggregateMetrics>> = {};
  for (const level of Object.keys(LEVEL_INDEX) as DegradeLevel[]) {
    const forLevel = entries.filter((e) => e.spec.level === level).map((e) => e.metrics);
    if (forLevel.length > 0) byLevel[level] = aggregate(forLevel);
  }
  return { entries, byLevel };
}
