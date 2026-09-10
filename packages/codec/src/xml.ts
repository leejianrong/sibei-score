/**
 * A tiny XML reader and writer, dependency-free (V8b).
 *
 * The codec is framework-free and Node-free (ADR-0004, `tests/arch`): it may depend only on the
 * other framework-free `@sibei/*` packages, so it cannot pull an XML library and there is no DOM to
 * lean on. MusicXML for a lead sheet is a small, regular subset of XML, so a hand-written scanner is
 * the right size of tool — the same "own the seam" call the engraver made against a rendering
 * library. It handles what MusicXML uses: the `<?xml?>` prolog, a `<!DOCTYPE>`, comments, CDATA,
 * elements with attributes, self-closing tags, and the five predefined entities plus numeric
 * character references. It is deliberately not a general XML processor — no namespaces, no internal
 * DTD subset — because the codec neither emits nor needs those.
 */

/** A parsed or built element. Text lives in child text nodes so mixed content round-trips. */
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export interface XmlText {
  text: string;
}

export type XmlNode = XmlElement | XmlText;

export function isElement(node: XmlNode): node is XmlElement {
  return 'name' in node;
}

/** A malformed document. The importer turns this into a flagged failure rather than a crash. */
export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

export type Attrs = Record<string, string | number | undefined>;

/**
 * Build an element. `undefined` attribute values are dropped, so a caller can pass an optional
 * attribute inline; `null`/`undefined`/`false` children are dropped for the same reason, and a
 * string child becomes a text node.
 */
export function elem(
  name: string,
  attrs: Attrs = {},
  children: (XmlNode | string | null | undefined | false)[] = [],
): XmlElement {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) kept[key] = String(value);
  }
  const nodes: XmlNode[] = [];
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    nodes.push(typeof child === 'string' ? { text: child } : child);
  }
  return { name, attrs: kept, children: nodes };
}

/** An element whose only content is text (`<step>C</step>`). */
export function leaf(name: string, text: string | number, attrs: Attrs = {}): XmlElement {
  return elem(name, attrs, [String(text)]);
}

export interface SerializeOptions {
  /** Emitted verbatim before the root, each on its own line (the `<?xml?>` prolog, a doctype). */
  prolog?: string[];
}

/** Serialise a tree to a stable, indented string. Deterministic: the same tree gives the same bytes. */
export function serialize(root: XmlElement, options: SerializeOptions = {}): string {
  const lines: string[] = [...(options.prolog ?? [])];
  writeElement(root, 0, lines);
  return `${lines.join('\n')}\n`;
}

function writeElement(el: XmlElement, depth: number, lines: string[]): void {
  const pad = '  '.repeat(depth);
  const open = attrString(el);

  if (el.children.length === 0) {
    lines.push(`${pad}<${el.name}${open}/>`);
    return;
  }

  // An element whose only child is text stays on one line: `<step>C</step>`.
  if (el.children.length === 1 && el.children[0] !== undefined && !isElement(el.children[0])) {
    lines.push(`${pad}<${el.name}${open}>${escapeText(el.children[0].text)}</${el.name}>`);
    return;
  }

  lines.push(`${pad}<${el.name}${open}>`);
  for (const child of el.children) {
    if (isElement(child)) writeElement(child, depth + 1, lines);
    else if (child.text.trim() !== '') lines.push(`${'  '.repeat(depth + 1)}${escapeText(child.text)}`);
  }
  lines.push(`${pad}</${el.name}>`);
}

function attrString(el: XmlElement): string {
  const keys = Object.keys(el.attrs);
  if (keys.length === 0) return '';
  return keys.map((key) => ` ${key}="${escapeAttr(el.attrs[key] ?? '')}"`).join('');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse a document to its root element, skipping the prolog, doctype and comments around it. */
export function parseXml(source: string): XmlElement {
  const scanner = new Scanner(source);
  scanner.skipProlog();
  const root = scanner.readElement();
  scanner.skipTrailing();
  return root;
}

class Scanner {
  private i = 0;
  constructor(private readonly s: string) {}

  skipProlog(): void {
    for (;;) {
      this.skipWhitespace();
      if (this.s.startsWith('<?', this.i)) {
        this.i = this.indexAfter('?>', '<?xml?> declaration');
      } else if (this.s.startsWith('<!--', this.i)) {
        this.i = this.indexAfter('-->', 'comment');
      } else if (this.s.startsWith('<!DOCTYPE', this.i)) {
        this.skipDoctype();
      } else {
        return;
      }
    }
  }

  skipTrailing(): void {
    for (;;) {
      this.skipWhitespace();
      if (this.s.startsWith('<!--', this.i)) this.i = this.indexAfter('-->', 'comment');
      else return;
    }
  }

  readElement(): XmlElement {
    if (this.s[this.i] !== '<') throw new XmlError(`expected an element at offset ${this.i}`);
    this.i += 1;
    const name = this.readName();
    const attrs = this.readAttrs();

    if (this.s.startsWith('/>', this.i)) {
      this.i += 2;
      return { name, attrs, children: [] };
    }
    if (this.s[this.i] !== '>') throw new XmlError(`malformed tag <${name}> at offset ${this.i}`);
    this.i += 1;

    const children = this.readChildren(name);
    return { name, attrs, children };
  }

  private readChildren(parent: string): XmlNode[] {
    const children: XmlNode[] = [];
    for (;;) {
      if (this.i >= this.s.length) throw new XmlError(`<${parent}> was never closed`);

      if (this.s.startsWith('</', this.i)) {
        this.i += 2;
        const closing = this.readName();
        this.skipWhitespace();
        if (this.s[this.i] !== '>') throw new XmlError(`malformed closing tag for <${parent}>`);
        this.i += 1;
        if (closing !== parent) throw new XmlError(`</${closing}> closes the wrong element; expected </${parent}>`);
        return children;
      }

      if (this.s.startsWith('<!--', this.i)) {
        this.i = this.indexAfter('-->', 'comment');
        continue;
      }
      if (this.s.startsWith('<![CDATA[', this.i)) {
        const end = this.s.indexOf(']]>', this.i);
        if (end === -1) throw new XmlError('a CDATA section was never closed');
        children.push({ text: this.s.slice(this.i + 9, end) });
        this.i = end + 3;
        continue;
      }
      if (this.s[this.i] === '<') {
        children.push(this.readElement());
        continue;
      }

      // Text up to the next tag.
      const next = this.s.indexOf('<', this.i);
      const raw = this.s.slice(this.i, next === -1 ? this.s.length : next);
      children.push({ text: decodeEntities(raw) });
      this.i = next === -1 ? this.s.length : next;
    }
  }

  private readAttrs(): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (;;) {
      this.skipWhitespace();
      const c = this.s[this.i];
      if (c === undefined || c === '>' || c === '/') return attrs;
      const name = this.readName();
      this.skipWhitespace();
      if (this.s[this.i] !== '=') throw new XmlError(`attribute ${name} has no value`);
      this.i += 1;
      this.skipWhitespace();
      const quote = this.s[this.i];
      if (quote !== '"' && quote !== "'") throw new XmlError(`attribute ${name} value is not quoted`);
      this.i += 1;
      const end = this.s.indexOf(quote, this.i);
      if (end === -1) throw new XmlError(`attribute ${name} value is never closed`);
      attrs[name] = decodeEntities(this.s.slice(this.i, end));
      this.i = end + 1;
    }
  }

  private readName(): string {
    const start = this.i;
    while (this.i < this.s.length && !/[\s/>=]/.test(this.s[this.i] ?? '')) this.i += 1;
    if (this.i === start) throw new XmlError(`expected a name at offset ${start}`);
    return this.s.slice(start, this.i);
  }

  private skipDoctype(): void {
    // `<!DOCTYPE ... >`, allowing a `[ ... ]` internal subset we do not otherwise interpret.
    this.i += '<!DOCTYPE'.length;
    let depth = 0;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === '[') depth += 1;
      else if (c === ']') depth -= 1;
      else if (c === '>' && depth <= 0) {
        this.i += 1;
        return;
      }
      this.i += 1;
    }
    throw new XmlError('a <!DOCTYPE> was never closed');
  }

  private skipWhitespace(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i] ?? '')) this.i += 1;
  }

  private indexAfter(marker: string, what: string): number {
    const end = this.s.indexOf(marker, this.i);
    if (end === -1) throw new XmlError(`a ${what} was never closed`);
    return end + marker.length;
  }
}

function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    switch (body) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        if (body.startsWith('#x') || body.startsWith('#X')) {
          return codePoint(parseInt(body.slice(2), 16));
        }
        if (body.startsWith('#')) return codePoint(parseInt(body.slice(1), 10));
        return whole; // An unknown named entity: leave it verbatim rather than drop it.
    }
  });
}

function codePoint(value: number): string {
  return Number.isFinite(value) && value >= 0 ? String.fromCodePoint(value) : '';
}

// ---------------------------------------------------------------------------
// Reading helpers, so the importer speaks in elements rather than indices
// ---------------------------------------------------------------------------

/** Direct child elements, optionally filtered by name. */
export function childElements(el: XmlElement, name?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const node of el.children) {
    if (isElement(node) && (name === undefined || node.name === name)) out.push(node);
  }
  return out;
}

/** The first direct child element of a name, or null. */
export function firstChild(el: XmlElement, name: string): XmlElement | null {
  for (const node of el.children) if (isElement(node) && node.name === name) return node;
  return null;
}

/** The concatenated text directly inside an element, trimmed. */
export function textContent(el: XmlElement): string {
  let text = '';
  for (const node of el.children) if (!isElement(node)) text += node.text;
  return text.trim();
}

/** The text of a named child, or null when the child is absent. */
export function childText(el: XmlElement, name: string): string | null {
  const child = firstChild(el, name);
  return child === null ? null : textContent(child);
}

/** An attribute value, or null. */
export function attr(el: XmlElement, name: string): string | null {
  return Object.prototype.hasOwnProperty.call(el.attrs, name) ? (el.attrs[name] ?? null) : null;
}
