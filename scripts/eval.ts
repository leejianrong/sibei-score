/**
 * The OMR evaluation harness entry point (V12).
 *
 *   pnpm eval                         # oemer worker on 127.0.0.1:8000, 6 charts x 4 degradations
 *   pnpm eval --engine fixture        # no oemer: a plumbing smoke over the committed OMR dump
 *   pnpm eval --seeds 12 --bars 16    # a bigger corpus
 *   pnpm eval --json                  # machine-readable
 *
 * It generates a synthetic corpus (`@sibei/synth`), degrades each chart to a photo
 * (`@sibei/synth/imaging`), runs a recogniser over it, scores the result against the ground truth
 * the generator recorded, and prints a table plus a real-photo control set beside it — the gap
 * between synthetic and real made visible (ADR-0020). Each run appends one line to
 * `eval/history.jsonl` so regressions are visible across commits.
 *
 * A development entry point, not a product surface. Note the worker holds oemer's ~7 GB model in
 * RAM (V9); on a small machine the run may be OOM-killed — that is a datum for v0.3, not a bug
 * (ADR-0031). It never touches the score store.
 *
 * The recogniser is a `Predict` seam, so this same harness scores oemer today and the bespoke
 * engine later without changing (ADR-0005, ADR-0031).
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { createHttpWorkerClient } from '@sibei/api';
import type { Score } from '@sibei/model';
import { mapOmrToScore, parseOmrDocument } from '@sibei/model';
import type { AggregateMetrics, OmrMetrics } from '@sibei/synth';
import { aggregate, scoreOmr } from '@sibei/synth';
import type { CorpusSpec, DegradeLevel, EvalReport, Predict } from '@sibei/synth/imaging';
import { runEval } from '@sibei/synth/imaging';

const REPO = resolve(import.meta.dirname, '..');
const ALL_LEVELS: DegradeLevel[] = ['clean', 'light', 'medium', 'heavy'];
const OMR_FIXTURE = join(REPO, 'tests/fixtures/omr/aaba-chart.omr.json');
const REAL_DIR = join(REPO, 'tests/fixtures/eval/real');
const HISTORY = join(REPO, 'eval/history.jsonl');

interface Args {
  engine: 'worker' | 'fixture';
  url: string;
  seeds: number;
  bars: number;
  levels: DegradeLevel[];
  zoom: number;
  json: boolean;
  history: boolean;
}

function parseArgs(argv: string[]): Args {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const engine = (value('--engine') ?? 'worker') as Args['engine'];
  const levelsArg = value('--levels');
  return {
    engine,
    url: value('--url') ?? process.env['SBSCORE_WORKER_URL'] ?? 'http://127.0.0.1:8000',
    seeds: Number(value('--seeds') ?? '6'),
    bars: Number(value('--bars') ?? '8'),
    levels: levelsArg ? (levelsArg.split(',') as DegradeLevel[]) : ALL_LEVELS,
    zoom: Number(value('--zoom') ?? '2'),
    json: argv.includes('--json'),
    history: !argv.includes('--no-history'),
  };
}

/** The recogniser under test. The worker path is the real oemer engine; fixture is a no-oemer smoke. */
async function makePredict(args: Args): Promise<Predict> {
  if (args.engine === 'fixture') {
    // Every entry gets the same mapped fixture score — this proves the pipeline, not accuracy.
    const raw = JSON.parse(await readFile(OMR_FIXTURE, 'utf8')) as unknown;
    const doc = parseOmrDocument(raw);
    const fixtureScore = mapOmrToScore([doc], { id: 'eval-fixture' });
    return async () => fixtureScore;
  }

  // Worker path: fail loudly and early if it is not reachable (rather than time out per image).
  await assertWorkerUp(args.url);
  const client = createHttpWorkerClient({ url: args.url });
  return async (image: Buffer, format, spec): Promise<Score> => {
    const doc = await client.recognize(image, {
      imagePath: `synth-${spec.seed}-${spec.level}.${format === 'jpeg' ? 'jpg' : 'png'}`,
      format,
    });
    return mapOmrToScore([doc], { id: `eval-${spec.seed}-${spec.level}` });
  };
}

async function assertWorkerUp(url: string): Promise<void> {
  try {
    const res = await fetch(`${url}/health`);
    if (!res.ok) throw new Error(`health returned ${res.status}`);
  } catch (error) {
    throw new Error(
      `no OMR worker at ${url} (${(error as Error).message}). Start it with the worker container, ` +
        `or run \`pnpm eval --engine fixture\` for a no-oemer smoke. On a small machine oemer's ` +
        `~7 GB model can be OOM-killed — see docs/eval.md.`,
    );
  }
}

/** One (seed x level) spec per chart, the corpus the run scores. */
function planCorpus(args: Args): CorpusSpec[] {
  const specs: CorpusSpec[] = [];
  for (let seed = 0; seed < args.seeds; seed += 1) {
    for (const level of args.levels) specs.push({ seed, bars: args.bars, level });
  }
  return specs;
}

interface RealEntry {
  name: string;
  metrics: OmrMetrics;
}

/** Score the hand-labelled real-photo control set, if any is present (ADR-0020 keeps it honest). */
async function runRealControlSet(predict: Predict): Promise<RealEntry[]> {
  if (!existsSync(REAL_DIR)) return [];
  const files = (await readdir(REAL_DIR)).filter((f) => f.endsWith('.json'));
  const results: RealEntry[] = [];
  for (const file of files) {
    const name = basename(file, '.json');
    const truth = JSON.parse(await readFile(join(REAL_DIR, file), 'utf8')) as Score;
    const image = await findImage(name);
    if (image === null) {
      process.stderr.write(`real/${name}: ground truth has no sibling image, skipping\n`);
      continue;
    }
    const format = image.ext === '.png' ? 'png' : 'jpeg';
    const predicted = await predict(image.data, format, { seed: -1, bars: 0, level: 'clean' });
    results.push({ name, metrics: scoreOmr(predicted, truth) });
  }
  return results;
}

async function findImage(name: string): Promise<{ data: Buffer; ext: string } | null> {
  for (const ext of ['.png', '.jpg', '.jpeg']) {
    const path = join(REAL_DIR, `${name}${ext}`);
    if (existsSync(path)) return { data: await readFile(path), ext: ext === '.jpeg' ? '.jpg' : ext };
  }
  return null;
}

function fmt(n: number): string {
  return n.toFixed(3);
}

function printTable(report: EvalReport, real: RealEntry[]): void {
  const head = ['corpus', 'charts', 'noteF1', 'noteAcc', 'chordF1', 'validBars'];
  const rows: string[][] = [];
  for (const level of ALL_LEVELS) {
    const agg = report.byLevel[level];
    if (agg) rows.push(row(level, agg));
  }
  if (real.length > 0) {
    rows.push(row(`real (${real.length})`, aggregate(real.map((r) => r.metrics))));
  }
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] as number)).join('  ');
  process.stdout.write(`${line(head)}\n`);
  process.stdout.write(`${widths.map((w) => '-'.repeat(w)).join('  ')}\n`);
  for (const r of rows) process.stdout.write(`${line(r)}\n`);
}

function row(label: string, agg: AggregateMetrics): string[] {
  return [label, String(agg.count), fmt(agg.noteF1), fmt(agg.noteAccuracy), fmt(agg.chordF1), fmt(agg.validBarsRatio)];
}

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: REPO }).toString().trim();
  } catch {
    return 'unknown';
  }
}

async function appendHistory(args: Args, report: EvalReport, real: RealEntry[]): Promise<void> {
  await mkdir(join(REPO, 'eval'), { recursive: true });
  const record = {
    timestamp: new Date().toISOString(),
    gitSha: gitSha(),
    engine: args.engine,
    seeds: args.seeds,
    bars: args.bars,
    synthetic: report.byLevel,
    real: real.length > 0 ? aggregate(real.map((r) => r.metrics)) : null,
  };
  await appendFile(HISTORY, `${JSON.stringify(record)}\n`);
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const predict = await makePredict(args);
  const report = await runEval(planCorpus(args), predict, { zoom: args.zoom });
  const real = await runRealControlSet(predict);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ byLevel: report.byLevel, real }, null, 2)}\n`);
  } else {
    printTable(report, real);
    if (real.length === 0) {
      process.stdout.write(
        `\n(no real control set in tests/fixtures/eval/real — add phone photos to keep the ` +
          `synthetic set honest; see tests/fixtures/eval/real/README.md)\n`,
      );
    }
  }
  if (args.history) await appendHistory(args, report, real);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  });
