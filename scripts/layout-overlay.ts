/**
 * Draw what `layout()` decided, as boxes and lines, with no engraver: the proof path for multi-staff layout
 * (SIB2-227), where slice 4's engraver does not exist yet. Open the PNGs and LOOK.
 *
 *   pnpm layout:overlay                      every multi-staff fixture, every page
 *   pnpm layout:overlay grand-staff          one fixture
 *   pnpm layout:overlay full-band --page 2   one page
 *
 * What is drawn, per system: the system's extent (grey box) and the chord/text row above the top staff (yellow band);
 * each staff's five lines; braces (blue boxes) and the bracket (red box); the span a barline makes across the staves
 * and each bar's start and end lines; every aligned column (green dashed, from the top staff to the bottom one);
 * and the items themselves: notes as filled dots (voice 1 dark, voice 2 magenta) on the staff's middle line at their
 * `x`, rests as hollow squares, chord symbols as orange diamonds in the chord row. If alignment is right, every dot
 * and diamond of one onset sits on one green line, whatever staff it is on.
 *
 * It is not a render: no glyph is drawn, so nothing here can say whether the engraving is right, only whether layout's
 * numbers are. Output goes to `out/layout-overlay/` (emptied per fixture, like `pnpm proof`).
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { FIXTURE_REGISTRY } from '@sibei/fixtures';
import type { LayoutPage, LayoutSystem } from '@sibei/layout';
import { isMultiLane, layout } from '@sibei/layout';


const OUT = resolve('out/layout-overlay');
const VOICE_COLOUR = ['#1c1c1c', '#c0148c', '#0a7c8c', '#8a5a00'];

function pageSvg(page: LayoutPage, staffHeight: number): string {
  const parts: string[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, width = 1, dash?: string): void => {
    parts.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}"${dash === undefined ? '' : ` stroke-dasharray="${dash}"`}/>`,
    );
  };
  const rect = (x: number, y: number, w: number, h: number, stroke: string, fill = 'none', opacity = 1): void => {
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" stroke="${stroke}" fill="${fill}" fill-opacity="${opacity}" stroke-width="1"/>`);
  };

  parts.push(`<rect width="${page.width}" height="${page.height}" fill="white"/>`);
  for (const system of page.systems) drawSystem(system, staffHeight, line, rect, parts);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.width} ${page.height}" width="${page.width}" height="${page.height}">${parts.join('')}</svg>`;
}

function drawSystem(
  system: LayoutSystem,
  staffHeight: number,
  line: (x1: number, y1: number, x2: number, y2: number, stroke: string, width?: number, dash?: string) => void,
  rect: (x: number, y: number, w: number, h: number, stroke: string, fill?: string, opacity?: number) => void,
  parts: string[],
): void {
  rect(system.x, system.y, system.width, system.height, '#bbbbbb');
  rect(system.x, system.y, system.width, system.aboveStaff, 'none', '#ffd23f', 0.25);
  const staves = system.staves ?? [{ staveY: system.staveY, bars: [], index: 0 }];
  for (const staff of staves) {
    for (let i = 0; i < 5; i += 1) line(system.x, staff.staveY + (i * staffHeight) / 4, system.x + system.width, staff.staveY + (i * staffHeight) / 4, '#9a9a9a', 0.7);
  }
  for (const group of system.groups ?? []) {
    rect(group.x, group.y, group.width, group.height, group.kind === 'brace' ? '#2f6fe4' : '#d12c2c', group.kind === 'brace' ? '#2f6fe4' : '#d12c2c', 0.12);
  }
  const span = system.staffSpan;
  if (span !== undefined) {
    line(system.x, span.y, system.x, span.y + span.height, '#222', 2);
    for (const bar of system.bars) {
      line(bar.x + bar.width, span.y, bar.x + bar.width, span.y + span.height, '#222', 1.5);
      line(bar.x, span.y, bar.x, span.y + span.height, '#cccccc', 0.5, '2 3');
    }
  }
  for (const bar of system.bars) {
    const top = span?.y ?? system.staveY;
    const bottom = span === undefined ? system.staveY + staffHeight : span.y + span.height;
    for (const column of bar.alignment?.columns ?? []) line(column.x, top - 4, column.x, bottom + 4, '#2aa84a', 0.8, '4 3');
  }
  for (const staff of system.staves ?? []) {
    const middle = staff.staveY + staffHeight / 2;
    for (const bar of staff.bars) {
      for (const voice of bar.voices) {
        const colour = VOICE_COLOUR[(voice.index - 1) % VOICE_COLOUR.length]!;
        const dy = bar.voices.length > 1 ? (voice.index === 1 ? -7 : 7) : 0;
        for (const item of voice.items) {
          if (item.kind === 'note' && item.x !== undefined) parts.push(`<circle cx="${item.x}" cy="${middle + dy}" r="3.6" fill="${colour}"/>`);
          if (item.kind === 'rest' && item.x !== undefined) parts.push(`<rect x="${item.x - 3.5}" y="${middle + dy - 3.5}" width="7" height="7" fill="white" stroke="${colour}"/>`);
        }
      }
    }
  }
  const chordY = system.staveY - system.chordBaselineOffset;
  for (const bar of system.bars) {
    for (const item of bar.items) {
      if ((item.kind === 'chordSymbol' || item.kind === 'annotation') && item.x !== undefined) {
        parts.push(`<polygon points="${item.x},${chordY - 5} ${item.x + 5},${chordY} ${item.x},${chordY + 5} ${item.x - 5},${chordY}" fill="#f08a00"/>`);
      }
    }
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const pageFlag = args.indexOf('--page');
  const only = pageFlag === -1 ? undefined : Number(args[pageFlag + 1]);
  const names = args.filter((arg, index) => !arg.startsWith('--') && index !== pageFlag + 1);
  const targets =
    names.length > 0
      ? names
      : Object.entries(FIXTURE_REGISTRY)
          .filter(([, build]) => isMultiLane(build()))
          .map(([name]) => name);

  mkdirSync(OUT, { recursive: true });
  for (const name of targets) {
    const build = FIXTURE_REGISTRY[name];
    if (build === undefined) throw new Error(`unknown fixture ${name}; try one of ${Object.keys(FIXTURE_REGISTRY).join(', ')}`);
    const result = layout(build());
    const dir = join(OUT, name);
    mkdirSync(dir, { recursive: true });
    for (const file of readdirSync(dir)) rmSync(join(dir, file));
    for (const page of result.pages) {
      if (only !== undefined && page.index + 1 !== only) continue;
      const svg = pageSvg(page, result.pageSpec.staffHeight);
      const stem = join(dir, `page${page.index + 1}`);
      writeFileSync(`${stem}.svg`, svg);
      writeFileSync(`${stem}.png`, new Resvg(svg, { background: 'white', fitTo: { mode: 'width', value: 1100 } }).render().asPng());
      console.log(`${name} page ${page.index + 1}: ${page.systems.length} system(s) -> ${stem}.png`);
    }
  }
}

main();
