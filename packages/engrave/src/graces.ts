import type { GraceItem } from '@sibei/layout';
import { GRACE_SCALE, GRACE_STEM_UNITS, writtenPitch } from '@sibei/layout';
import type { BeamMember } from './beams.js';
import { applyBeam, beamElements, beamLine, beamYAt } from './beams.js';
import type { MusicFont } from './font.js';
import { scaledFont, units } from './font.js';
import { ACCIDENTAL_GAP, accidentalGlyph } from './spacing.js';
import { ledgerLines, positionY, staffPosition } from './staff.js';
import { beamCount, flagFor, flagOrigin, stem, stemElement } from './stems.js';
import type { Stem } from './stems.js';
import type { SvgElement } from './svg.js';
import { el } from './svg.js';

/**
 * Grace notes (SIB2-185): small noteheads with an up stem, drawn in the room spacing left before their principal.
 *
 * They are drawn through the same geometry as a note — `stem`, `ledgerLines`, `beamElements` — fed a font scaled by
 * `GRACE_SCALE`, so a grace's stem attaches by the font's own anchors and its beam thickness follows the font, not a
 * number of ours. A single grace carries a flag; two or more share one beam, whatever the bar's beaming does around
 * them (they sit outside the bar's time). An acciaccatura is struck through with a slash across its stem, or across
 * the whole group's stems when beamed.
 */
export function graceInk(
  font: MusicFont,
  graces: readonly GraceItem[],
  xs: readonly number[],
  ottava: 'up' | 'down' | undefined,
  staveY: number,
): SvgElement[] {
  if (graces.length === 0) return [];
  const small = scaledFont(font, GRACE_SCALE);
  const head = 'noteheadBlack';
  const ink: SvgElement[] = [];
  const stems: { stem: Stem; position: number; levels: number }[] = [];

  for (const [index, grace] of graces.entries()) {
    const x = xs[index];
    if (x === undefined) continue;
    const position = staffPosition(writtenPitch(grace.pitch, ottava));
    const y = positionY(position, staveY);

    ink.push(...ledgerLines(small, { noteX: x, noteheadWidth: small.width(head), position, staveY }));

    if (grace.accidentalGlyph !== null) {
      const glyph = accidentalGlyph(grace.accidentalGlyph);
      if (grace.accidental === 'parens') {
        const right = x - ACCIDENTAL_GAP * GRACE_SCALE - small.width('accidentalParensRight');
        const glyphX = right - small.width(glyph);
        ink.push(small.element('accidentalParensRight', right, y));
        ink.push(small.element(glyph, glyphX, y));
        ink.push(small.element('accidentalParensLeft', glyphX - small.width('accidentalParensLeft'), y));
      } else {
        ink.push(small.element(glyph, x - ACCIDENTAL_GAP * GRACE_SCALE - small.width(glyph), y));
      }
    }

    ink.push(small.element(head, x, y));
    const built = stem(small, { notehead: head, direction: 'up', noteX: x, position, staveY });
    // A grace's stem is short and fixed, not the standard three and a half spaces.
    built.endY = y - GRACE_STEM_UNITS;
    stems.push({ stem: built, position, levels: beamCount({ value: grace.value, dots: 0 }) });
  }

  const first = stems[0];
  const last = stems[stems.length - 1];
  if (first === undefined || last === undefined) return ink;

  let slashFrom: { x: number; y: number };
  let slashTo: { x: number; y: number };
  const reach = units(0.65);

  if (stems.length >= 2) {
    const members: BeamMember[] = stems.map((entry) => ({ stem: entry.stem, position: entry.position, levels: entry.levels }));
    const line = beamLine(members);
    applyBeam(line, members);
    for (const entry of stems) ink.push(stemElement(entry.stem));
    ink.push(...beamElements(small, line, members));
    slashFrom = { x: first.stem.centre - reach, y: beamYAt(line, first.stem.centre) + units(1.5) };
    slashTo = { x: last.stem.centre + reach, y: beamYAt(line, last.stem.centre) + units(0.5) };
  } else {
    ink.push(stemElement(first.stem));
    const flag = flagFor({ value: graces[0]?.value ?? 8, dots: 0 }, 'up');
    if (flag !== null) {
      const origin = flagOrigin(small, flag, first.stem);
      ink.push(small.element(flag, origin.x, origin.y));
    }
    slashFrom = { x: first.stem.centre - reach, y: first.stem.endY + units(1.5) };
    slashTo = { x: first.stem.centre + reach, y: first.stem.endY + units(0.5) };
  }

  if (graces[0]?.slashed === true) {
    ink.push(
      el('path', {
        class: 'se-graceslash',
        d: `M${slashFrom.x} ${slashFrom.y}L${slashTo.x} ${slashTo.y}`,
        fill: 'none',
        stroke: '#000000',
        'stroke-width': small.ink.stem * 1.2,
      }),
    );
  }
  return ink;
}
