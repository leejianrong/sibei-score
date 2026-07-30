import type { PageSpecInput } from '@sibei/layout';
import { layout } from '@sibei/layout';
import type { Score } from '@sibei/model';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import { pdfFontFor } from './fonts.js';
import type { RenderedPage } from './svg.js';
import { renderLayoutToSvg } from './svg.js';

/**
 * Server-side VexFlow to SVG to PDF (ADR-0014).
 *
 * Every value that would otherwise vary is pinned, so a given score always produces
 * identical bytes: fixed creation and modification dates, a fixed producer string,
 * base-14 fonts only, and no VexFlow element ids. Regression tests snapshot the SVG
 * rather than these bytes, because PDF structure shifts with library versions in ways
 * that are noise (Q39) — but the byte-identity itself is worth having and is tested.
 */

/** Never a timestamp: a timestamp is the one thing that would break reproducibility. */
const PINNED_DATE = new Date(0);

const PRODUCER = 'sibei-score';

export interface PdfMetadata {
  title: string;
  author: string;
  subject: string;
}

export function pdfMetadataFor(score: Score): PdfMetadata {
  return {
    title: score.meta.title,
    author: score.meta.composer,
    subject: score.meta.style ?? '',
  };
}

export function renderPagesToPdf(pages: RenderedPage[], metadata: PdfMetadata): Promise<Buffer> {
  const first = pages[0];
  if (first === undefined) throw new Error('nothing to render: no pages');

  const doc = new PDFDocument({
    autoFirstPage: false,
    info: {
      Title: metadata.title,
      Author: metadata.author,
      Subject: metadata.subject,
      Creator: PRODUCER,
      Producer: PRODUCER,
      CreationDate: PINNED_DATE,
      ModDate: PINNED_DATE,
    },
  });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  for (const page of pages) {
    doc.addPage({ size: [page.widthPt, page.heightPt], margin: 0 });
    SVGtoPDF(doc, page.svg, 0, 0, {
      width: page.widthPt,
      height: page.heightPt,
      assumePt: true,
      preserveAspectRatio: 'xMidYMid meet',
      fontCallback: pdfFontFor,
    });
  }

  doc.end();
  return done;
}

export function renderScoreToPdf(score: Score, pageSpec: PageSpecInput = {}): Promise<Buffer> {
  const result = layout(score, pageSpec);
  return renderPagesToPdf(renderLayoutToSvg(result), pdfMetadataFor(score));
}
