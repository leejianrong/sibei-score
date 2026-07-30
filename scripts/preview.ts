/**
 * Rasterise a rendered SVG page to PNG, so the engraving can be looked at without a
 * PDF viewer. A development aid only: nothing in the product depends on it, and it is
 * deliberately not part of the render path.
 *
 *   pnpm tsx scripts/preview.ts out/nasty-chart.page1.svg 2
 *   pnpm tsx scripts/preview.ts out/nasty-chart.page1.svg 4 --crop 60,180,1000,180
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

async function main(argv: string[]): Promise<number> {
  const input = argv[0];
  if (input === undefined) {
    process.stderr.write('usage: preview.ts <page.svg> [zoom] [--crop x,y,w,h]\n');
    return 2;
  }
  const zoom = Number(argv[1] ?? '2');
  let svg = await readFile(resolve(input), 'utf8');

  const cropIndex = argv.indexOf('--crop');
  let suffix = '';
  if (cropIndex !== -1) {
    const box = (argv[cropIndex + 1] ?? '').split(',').map(Number);
    const [x = 0, y = 0, width = 100, height = 100] = box;
    svg = svg
      .replace(/viewBox="[^"]*"/, `viewBox="${x} ${y} ${width} ${height}"`)
      .replace(/width="[^"]*"/, `width="${width}"`)
      .replace(/height="[^"]*"/, `height="${height}"`);
    suffix = `.crop`;
  }

  const png = new Resvg(svg, {
    background: 'white',
    fitTo: { mode: 'zoom', value: zoom },
  })
    .render()
    .asPng();

  const output = resolve(input.replace(/\.svg$/, `${suffix}.png`));
  await writeFile(output, png);
  process.stdout.write(`wrote ${output} (${png.length} bytes)\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`);
    process.exit(1);
  },
);
