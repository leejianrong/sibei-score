import { createHttpWorkerClient } from '@sibei/api';
import type { Score } from '@sibei/model';
import { mapOmrToScore } from '@sibei/model';
import { generateScore } from '@sibei/synth';
import type { CorpusSpec, Predict } from '@sibei/synth/imaging';
import { runEval } from '@sibei/synth/imaging';
import { describe, expect, it } from 'vitest';

/**
 * The eval harness wiring: corpus generation → degradation → a recogniser → scoring → aggregation
 * (ADR-0020). Infra layer — it rasterises and degrades with native bindings.
 *
 * The plumbing is tested with an *injected fake* recogniser so it is deterministic and needs no
 * oemer: the fake returns the exact truth for a clean image and a damaged transcription for a
 * degraded one, so the aggregated table must show clean scoring above degraded — which is the
 * sensitivity the harness exists to have. The real oemer path is a separate, self-skipping smoke.
 */

/** A recogniser stand-in: perfect on clean, drops a note on anything degraded. */
const fakePredict: Predict = async (_image, _format, spec: CorpusSpec): Promise<Score> => {
  const truth = generateScore({ seed: spec.seed, bars: spec.bars });
  if (spec.level === 'clean') return truth;
  return {
    ...truth,
    bars: truth.bars.map((bar, index) =>
      index === 0 ? { ...bar, items: bar.items.slice(1) } : bar,
    ),
  };
};

describe('runEval (plumbing, fake recogniser)', () => {
  it('scores every entry and aggregates by degradation level', async () => {
    const specs: CorpusSpec[] = [
      { seed: 0, bars: 4, level: 'clean' },
      { seed: 1, bars: 4, level: 'clean' },
      { seed: 0, bars: 4, level: 'heavy' },
      { seed: 1, bars: 4, level: 'heavy' },
    ];
    const report = await runEval(specs, fakePredict, { zoom: 1 });

    expect(report.entries).toHaveLength(4);
    expect(report.byLevel.clean?.count).toBe(2);
    expect(report.byLevel.heavy?.count).toBe(2);
  });

  it('is sensitive: a degraded corpus scores below a clean one', async () => {
    const specs: CorpusSpec[] = [
      { seed: 5, bars: 4, level: 'clean' },
      { seed: 5, bars: 4, level: 'heavy' },
    ];
    const report = await runEval(specs, fakePredict, { zoom: 1 });
    expect(report.byLevel.clean?.noteF1).toBe(1);
    expect(report.byLevel.heavy?.noteF1 as number).toBeLessThan(1);
  });

  it('produces a jpeg for a degraded entry and a png for a clean one', async () => {
    const report = await runEval(
      [
        { seed: 2, bars: 4, level: 'clean' },
        { seed: 2, bars: 4, level: 'medium' },
      ],
      fakePredict,
      { zoom: 1 },
    );
    const byLevel = (level: string): 'png' | 'jpeg' =>
      report.entries.find((e) => e.spec.level === level)?.format as 'png' | 'jpeg';
    expect(byLevel('clean')).toBe('png');
    expect(byLevel('medium')).toBe('jpeg');
  });
});

describe('runEval (real oemer, self-skipping)', () => {
  const url = process.env['SBSCORE_WORKER_URL'] ?? 'http://127.0.0.1:8000';

  it('recognises one degraded chart end to end when a worker is up', async (ctx) => {
    let up = false;
    try {
      const res = await fetch(`${url}/health`);
      up = res.ok;
    } catch {
      up = false;
    }
    if (!up) {
      // No worker here (no oemer / OOM on a small host) — the honest report is skip, not fail,
      // mirroring tests/e2e/omr-spike.test.ts and the arch fast-layer skip (KAN-514).
      ctx.skip();
      return;
    }

    const client = createHttpWorkerClient({ url });
    const realPredict: Predict = async (image, format, spec) => {
      const doc = await client.recognize(image, { imagePath: `smoke-${spec.seed}`, format });
      return mapOmrToScore([doc], { id: `smoke-${spec.seed}` });
    };
    const report = await runEval([{ seed: 0, bars: 8, level: 'light' }], realPredict, { zoom: 2 });
    // We do not assert accuracy here (that is what `make eval` measures) — only that a real
    // recognition flowed image → worker → OmrDocument → Score → metrics without throwing.
    expect(report.entries).toHaveLength(1);
    expect(report.byLevel.light?.count).toBe(1);
  });
});
