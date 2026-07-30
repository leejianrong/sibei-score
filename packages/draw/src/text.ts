import type { LayoutText, LayoutTextRole } from '@sibei/layout';

/**
 * Page text — the title block and bar numbers — is written straight into the SVG with
 * `text-anchor`, rather than through VexFlow's context.
 *
 * The reason is drift. VexFlow centres text by measuring it, and its SVG backend
 * measures with `getBBox()`, which only a real browser implements. Measuring
 * server-side would therefore place text differently from the browser, and ADR-0015
 * requires that screen and print cannot drift. `text-anchor` moves the alignment into
 * the SVG itself, where both environments agree by construction.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface TextStyle {
  family: string;
  weight: string;
  style: string;
}

const SERIF = 'Times New Roman, serif';

export function styleForRole(role: LayoutTextRole): TextStyle {
  switch (role) {
    case 'title':
      return { family: SERIF, weight: 'bold', style: 'normal' };
    case 'composer':
      return { family: SERIF, weight: 'normal', style: 'italic' };
    case 'style':
      return { family: SERIF, weight: 'normal', style: 'italic' };
  }
}

const ANCHOR = { left: 'start', center: 'middle', right: 'end' } as const;

export interface DrawTextSpec {
  text: string;
  x: number;
  y: number;
  size: number;
  align: 'left' | 'center' | 'right';
  family: string;
  weight: string;
  style: string;
}

export function appendText(svg: SVGSVGElement, spec: DrawTextSpec): SVGTextElement {
  const doc = svg.ownerDocument;
  const element = doc.createElementNS(SVG_NS, 'text');
  element.setAttribute('x', String(spec.x));
  element.setAttribute('y', String(spec.y));
  element.setAttribute('font-family', spec.family);
  element.setAttribute('font-size', `${spec.size}px`);
  element.setAttribute('font-weight', spec.weight);
  element.setAttribute('font-style', spec.style);
  element.setAttribute('text-anchor', ANCHOR[spec.align]);
  element.setAttribute('fill', '#000000');
  element.setAttribute('stroke', 'none');
  element.textContent = spec.text;
  svg.appendChild(element);
  return element;
}

export function appendHeaderText(svg: SVGSVGElement, text: LayoutText): SVGTextElement {
  const style = styleForRole(text.role);
  return appendText(svg, {
    text: text.text,
    x: text.x,
    y: text.y,
    size: text.size,
    align: text.align,
    ...style,
  });
}
