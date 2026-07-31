/**
 * A minimal SVG writer: build a node tree, serialise it to markup.
 *
 * The engraver emits **markup, not DOM nodes**, and that is a deliberate difference
 * from the VexFlow adapter. VexFlow needs a `document` to build elements with, which
 * is why the PDF path installs jsdom (`packages/pdf/src/svg.ts`). Nothing here needs
 * one, so this package stays framework-free and Node-free like `layout` and `model`,
 * and it renders identically in the browser, in a test, and on the server.
 *
 * Numbers are rounded on the way out. Byte-identical output run to run is a
 * requirement (Q39), and floating-point tails are the usual way that breaks.
 */

export interface SvgElement {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string | number>>;
  readonly children: readonly SvgElement[];
  /** Mixed content, for `<text>`: literal strings and `<tspan>` runs. */
  readonly text?: readonly (SvgElement | string)[];
}

export function el(
  name: string,
  attrs: Readonly<Record<string, string | number>>,
  children: readonly SvgElement[] = [],
): SvgElement {
  return { name, attrs, children };
}

/** Three decimals is finer than a printer resolves and keeps the output stable. */
export function num(value: number): string {
  const rounded = Number(value.toFixed(3));
  // `-0` serialises as "-0", which is a pointless difference between two identical runs.
  return String(rounded === 0 ? 0 : rounded);
}

function attributeValue(value: string | number): string {
  return typeof value === 'number' ? num(value) : value;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

function escape(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ESCAPES[character] ?? character);
}

export function serialise(element: SvgElement): string {
  const attrs = Object.entries(element.attrs)
    .map(([name, value]) => ` ${name}="${escape(attributeValue(value))}"`)
    .join('');

  if (element.text !== undefined) {
    const body = element.text
      .map((part) => (typeof part === 'string' ? escape(part) : serialise(part)))
      .join('');
    return `<${element.name}${attrs}>${body}</${element.name}>`;
  }
  if (element.children.length === 0) return `<${element.name}${attrs}/>`;
  return `<${element.name}${attrs}>${element.children.map(serialise).join('')}</${element.name}>`;
}

/**
 * A text node. Page text — the title block, bar numbers, rehearsal marks, chord
 * symbols — is written into the SVG with `text-anchor` and never measured, because
 * `getBBox` exists only in a real browser and ADR-0015 requires that screen and print
 * cannot drift (`packages/draw/src/text.ts` says the same for the other adapter).
 */
export function textEl(
  attrs: Readonly<Record<string, string | number>>,
  children: readonly (SvgElement | string)[],
): SvgElement {
  return { name: 'text', attrs, children: [], text: children };
}
