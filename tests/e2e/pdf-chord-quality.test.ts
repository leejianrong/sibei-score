import { nastyChart } from '@sibei/fixtures';
import { renderScoreToPdf } from '@sibei/pdf';
import { describe, expect, it } from 'vitest';

/**
 * SIB2-162: the chord quality glyphs (`Δ`, `ø`) are not in Times-Roman's WinAnsi set, so the base-14
 * PDF printed `Ebmaj7` as `Eb7`. The serif is now embedded (subsetted, so still deterministic).
 * Text extraction was checked by hand with `pdftotext` ("EbΔ7"); here the guard is that the PDF
 * carries an embedded TrueType program for the face, which is what makes the glyphs exist at all.
 */
describe('PDF chord quality glyphs', () => {
  it('embeds the serif face rather than naming base-14 Times-Roman', async () => {
    const pdf = (await renderScoreToPdf(nastyChart())).toString('latin1');
    expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+Tinos-Regular/);
    expect(pdf).toContain('/FontFile2');
    expect(pdf).not.toContain('/BaseFont /Times-Roman');
  });

  it('stays byte-identical run to run', async () => {
    const [a, b] = [await renderScoreToPdf(nastyChart()), await renderScoreToPdf(nastyChart())];
    expect(a.equals(b)).toBe(true);
  });
});
