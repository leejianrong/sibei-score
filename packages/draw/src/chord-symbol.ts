import { ChordSymbol, Font } from 'vexflow';

/**
 * Typesetting a chord symbol: root at full size, extensions superscripted, a slash
 * bass back at full size. That is the jazz convention and it is what makes
 * `F#m7b5` read correctly rather than as a run of same-size characters.
 *
 * This is presentation only — it splits the text, it does not understand it. Parsing
 * chord text into root, quality, extensions, alterations and bass is the `music`
 * package's job (ADR-0012, P8), and V5 replaces the split below with that structure.
 */

const ROOT_PATTERN = /^([A-G](?:##|bb|#|b)?)(.*)$/;

export interface ChordSymbolOptions {
  fontSize: number;
}

function blank(options: ChordSymbolOptions): ChordSymbol {
  const symbol = new ChordSymbol();
  symbol.setFont(Font.SERIF, options.fontSize, 'normal');
  symbol.setHorizontal('left');
  symbol.setVertical('top');
  return symbol;
}

export function buildChordSymbol(text: string, options: ChordSymbolOptions): ChordSymbol {
  const symbol = blank(options);
  const match = ROOT_PATTERN.exec(text);

  if (match === null) {
    // `N.C.`, or text the grammar will later flag. Verbatim, and without glyph
    // substitution: it turns the b of a word into a flat sign.
    symbol.addText(text);
    return symbol;
  }

  const [, root = '', remainder = ''] = match;
  symbol.addGlyphOrText(root);

  const slash = remainder.lastIndexOf('/');
  const quality = slash === -1 ? remainder : remainder.slice(0, slash);
  const bass = slash === -1 ? '' : remainder.slice(slash + 1);

  if (quality !== '') {
    symbol.addGlyphOrText(quality, { symbolModifier: ChordSymbol.symbolModifiers.SUPERSCRIPT });
  }
  if (bass !== '') {
    // The slash stays a text character. VexFlow has a glyph for it, but the glyph is a
    // full-height stroke meant for rhythm slashes and it dwarfs the chord next to it.
    symbol.addText('/');
    symbol.addGlyphOrText(bass);
  }

  return symbol;
}

/**
 * Free text in the chord band — an instruction, or something the recogniser could not
 * read (Q56). Never glyph-substituted: `solo break` must not come out as `solo♭reak`.
 */
export function buildTextSymbol(text: string, options: ChordSymbolOptions): ChordSymbol {
  const symbol = blank(options);
  symbol.addText(text);
  return symbol;
}
