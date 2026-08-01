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

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  everyGlyphChart,
  invalidBarChart,
  longFormChart,
  nastyChart,
  untitledChart,
} from '@sibei/fixtures';
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
  untitled: untitledChart,
};

/**
 * One directory per fixture under here, so a chart's PDF and its pages sit together and
 * `out/` does not become a flat pile that nothing owns. `out/` is gitignored in full.
 */
const RENDER_DIR = resolve('out/render');

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
  for (const name of names) await render(name, paper);
  return 0;
}

async function render(name: string, paper: Paper): Promise<void> {
  const build = FIXTURES[name];
  if (build === undefined) throw new Error(`unknown fixture: ${name}`);
  const score = build();
  const result = layout(score, { paper });
  const pages = renderScoreToSvg(score, { paper });
  const pdf = await renderScoreToPdf(score, { paper });

  // A directory per fixture, emptied first. Emptying is the point: a chart that used to
  // paginate onto three pages and now fits two would otherwise leave `page3.svg` behind
  // looking current, and nothing would ever say so.
  const outDir = resolve(RENDER_DIR, name);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // The PDF keeps the fixture's name because it is the thing you open, attach or hand to
  // somebody; the SVG pages drop it because the directory already said it.
  const pdfPath = resolve(outDir, `${name}.pdf`);
  await writeFile(pdfPath, pdf);
  for (const page of pages) {
    await writeFile(resolve(outDir, `page${page.index + 1}.svg`), page.svg);
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
