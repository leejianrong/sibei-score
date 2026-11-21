import type { SvgElement } from './svg.js';
import { el } from './svg.js';
import { text } from './text.js';

/**
 * An ottava line (SIB2-184): `8va` (or `8vb`), a dashed line, and a hook at the end turned toward the notes.
 * `y` is the line's own height, which layout reserved (so the chord row clears it); the label is centred on it
 * with `text-anchor`, never measured (ADR-0015), so the dashes start after an estimated label width.
 */
export interface OttavaSpec {
  shift: 'up' | 'down';
  /** Where the line starts and where it ends. */
  from: number;
  to: number;
  y: number;
  /** The `8va` label, only on the system a line starts on. */
  labelled: boolean;
  /** The hook at the end, only on the system a line ends on. */
  hooked: boolean;
  size: number;
}

const LABEL_ADVANCE_EM = 0.6;

export function ottavaLine(spec: OttavaSpec): SvgElement[] {
  const out: SvgElement[] = [];
  const label = spec.shift === 'up' ? '8va' : '8vb';
  let start = spec.from;
  if (spec.labelled) {
    out.push(
      text({
        text: label,
        x: spec.from,
        y: spec.y + spec.size * 0.35,
        size: spec.size,
        align: 'left',
        style: 'italic',
        class: 'se-ottava',
      }),
    );
    start = spec.from + spec.size * LABEL_ADVANCE_EM * label.length + spec.size * 0.4;
  }
  if (spec.to > start) {
    out.push(
      el('path', {
        class: 'se-ottavaline',
        d: `M${start} ${spec.y}L${spec.to} ${spec.y}`,
        fill: 'none',
        stroke: '#000000',
        'stroke-width': 1,
        'stroke-dasharray': `${spec.size * 0.4} ${spec.size * 0.3}`,
      }),
    );
  }
  if (spec.hooked) {
    // The hook points at the notes: down from an 8va line, up from an 8vb one.
    const toward = spec.shift === 'up' ? spec.size * 0.8 : -spec.size * 0.8;
    out.push(
      el('path', {
        class: 'se-ottavahook',
        d: `M${spec.to} ${spec.y}L${spec.to} ${spec.y + toward}`,
        fill: 'none',
        stroke: '#000000',
        'stroke-width': 1,
      }),
    );
  }
  return out;
}
