import type { LayoutFurniture } from '@sibei/layout';
import type { SvgElement } from './svg.js';
import { text } from './text.js';

/**
 * Page furniture (SIB2-171): a page number in the margin. Plain upright text, placed with
 * `text-anchor` and never measured (ADR-0015), in the same family as the title block so a varied
 * render stays one face.
 */
export function furnitureText(item: LayoutFurniture, family?: string): SvgElement {
  return text({
    text: item.text,
    x: item.x,
    y: item.y,
    size: item.size,
    align: item.align,
    class: `se-${item.role}`,
    ...(family === undefined ? {} : { family }),
  });
}
