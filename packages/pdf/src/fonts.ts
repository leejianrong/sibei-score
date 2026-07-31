/**
 * SVG font families mapped to PDF base-14 fonts.
 *
 * The engraver draws every music glyph as a filled path taken from a SMuFL font's own
 * outlines, so the only *text* in the SVG is chord symbols, rehearsal letters, the title
 * block and bar numbers. Those map onto the base-14 fonts, which means no font is
 * embedded, nothing is subsetted, and the bytes are stable run to run (Q39).
 *
 * That is the property VexFlow 5 would have cost us and the reason 4.2.5 was pinned
 * (`docs/v1-render-gate.md`). Owning the engraver keeps it without the pin.
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
