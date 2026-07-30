/**
 * SVG font families mapped to PDF base-14 fonts.
 *
 * VexFlow 4 draws every music glyph as a filled path, so the only text in the SVG is
 * chord symbols, rehearsal letters, the title block and bar numbers. Those map onto
 * the base-14 fonts, which means no font is embedded, nothing is subsetted, and the
 * bytes are stable run to run (Q39).
 */

const SERIF_PATTERN = /times|serif|roboto slab|georgia|garamond/i;

export function pdfFontFor(family: string, bold: boolean, italic: boolean): string {
  if (SERIF_PATTERN.test(family)) {
    if (bold && italic) return 'Times-BoldItalic';
    if (bold) return 'Times-Bold';
    if (italic) return 'Times-Italic';
    return 'Times-Roman';
  }
  if (bold && italic) return 'Helvetica-BoldOblique';
  if (bold) return 'Helvetica-Bold';
  if (italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}
