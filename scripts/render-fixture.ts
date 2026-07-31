/**
 * The V1 demo: one command, from a fixture to a PDF you can open.
 *
 *   pnpm render:nasty
 *   pnpm render invalid-bars --paper letter
 *   pnpm render all
 *
 * This is a development entry point, not the product's surface. Export belongs to the
 * API and the CLI, which arrive in V2 and V3.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { everyGlyphChart, invalidBarChart, longFormChart, nastyChart } from '@sibei/fixtures';
import type { Paper } from '@sibei/layout';
import { layout } from '@sibei/layout';
import { scoreMetrics } from '@sibei/model';
import type { Score } from '@sibei/model';
import { renderScoreToPdf, renderScoreToSvg } from '@sibei/pdf';

const FIXTURES: Record<string, () => Score> = {
  'nasty-chart': nastyChart,
  'every-glyph': everyGlyphChart,
  'invalid-bars': invalidBarChart,
  'long-form': longFormChart,
};

async function main(argv: string[]): Promise<number> {
  const requested = argv[0] ?? 'nasty-chart';
  const names = requested === 'all' ? Object.keys(FIXTURES) : [requested];

  for (const name of names) {
    if (FIXTURES[name] === undefined) {
      process.stderr.write(
        `unknown fixture: ${name}\nknown: ${Object.keys(FIXTURES).join(', ')}, all\n`,
      );
      return 2;
    }
  }

  const paperIndex = argv.indexOf('--paper');
  const paper = (paperIndex === -1 ? 'a4' : argv[paperIndex + 1]) as Paper;
  const outDir = resolve('out');
  await mkdir(outDir, { recursive: true });

  for (const name of names) await render(name, paper, outDir);
  return 0;
}

async function render(name: string, paper: Paper, outDir: string): Promise<void> {
  const build = FIXTURES[name];
  if (build === undefined) throw new Error(`unknown fixture: ${name}`);
  const score = build();
  const result = layout(score, { paper });
  const pages = renderScoreToSvg(score, { paper });
  const pdf = await renderScoreToPdf(score, { paper });

  const pdfPath = resolve(outDir, `${name}.pdf`);
  await writeFile(pdfPath, pdf);
  for (const page of pages) {
    await writeFile(resolve(outDir, `${name}.page${page.index + 1}.svg`), page.svg);
  }

  const invalid = scoreMetrics(score).filter((m) => !m.valid);
  process.stdout.write(
    [
      `${name}: ${score.bars.length} bars, ${result.systemCount} systems, ${result.pages.length} page(s), ${paper}`,
      `systems per page: ${result.pages.map((p) => p.systems.length).join(', ')}`,
      `metrically invalid bars: ${invalid.length === 0 ? 'none' : invalid.map((m) => `${m.barNumber} (${m.status})`).join(', ')}`,
      `wrote ${pdfPath} (${pdf.length} bytes)`,
      '',
    ].join('\n'),
  );
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`);
    process.exit(1);
  },
);
