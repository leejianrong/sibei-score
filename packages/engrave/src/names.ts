import type { LayoutSystem } from '@sibei/layout';
import type { SvgElement } from './svg.js';
import { text } from './text.js';

/** One staff is 40 units tall. */
const STAFF_HEIGHT = 40;
/** Where a name's baseline sits below its vertical centre, as a fraction of its size (cap height is about 0.7). */
const BASELINE_DROP = 0.35;

/**
 * The instrument names at the head of a system (SIB2-286): each centred on its part's staves, right-aligned at the x
 * layout chose, left of any brace or bracket. Placed with `text-anchor` and never measured (ADR-0015).
 */
export function instrumentNames(system: LayoutSystem, family?: string): SvgElement[] {
  return (system.names ?? []).map((name) => {
    const top = system.staves?.[name.firstStaff]?.staveY ?? system.staveY;
    const bottom = (system.staves?.[name.lastStaff]?.staveY ?? system.staveY) + STAFF_HEIGHT;
    return text({
      text: name.text,
      x: name.x,
      y: (top + bottom) / 2 + name.size * BASELINE_DROP,
      size: name.size,
      align: 'right',
      class: 'se-instrument-name',
      ...(family === undefined ? {} : { family }),
    });
  });
}
