import { drawPage } from '@sibei/draw';
import type { LayoutResult, PageSpecInput } from '@sibei/layout';
import { layout } from '@sibei/layout';
import type { Score } from '@sibei/model';
import { JSDOM } from 'jsdom';

/**
 * The server side of "screen and print share one layout path" (ADR-0014). The same
 * `layout` package and the same `draw` adapter the browser uses, over a headless DOM.
 */

const SVG_NS_ATTRIBUTE = 'xmlns="http://www.w3.org/2000/svg"';

/**
 * VexFlow's SVG backend builds elements with the global `document`, so one has to
 * exist. Installed once and left in place: creating a DOM per render would be slow
 * and would not change any output.
 */
let installedDom: JSDOM | null = null;

function ensureDom(): JSDOM {
  if (installedDom !== null) return installedDom;
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const globals = globalThis as Record<string, unknown>;
  globals['window'] = dom.window;
  globals['document'] = dom.window.document;
  installedDom = dom;
  return dom;
}

/**
 * VexFlow numbers its elements from a process-global counter, so the same score
 * rendered twice in one process would carry different `id` attributes. The ids exist
 * for browser hit-testing and mean nothing in a file, so they are dropped here —
 * which is what makes an exported PDF byte-identical run to run (Q39).
 */
function stripAutoIds(svg: string): string {
  return svg.replace(/ id="vf-auto\d+"/g, '');
}

export interface RenderedPage {
  index: number;
  svg: string;
  widthPt: number;
  heightPt: number;
}

export function renderLayoutToSvg(result: LayoutResult): RenderedPage[] {
  const dom = ensureDom();
  const pages: RenderedPage[] = [];

  for (const page of result.pages) {
    const host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    try {
      drawPage(result, page.index, host);
      const markup = host.innerHTML;
      pages.push({
        index: page.index,
        svg: stripAutoIds(withNamespace(markup)),
        widthPt: page.widthPt,
        heightPt: page.heightPt,
      });
    } finally {
      host.remove();
    }
  }

  return pages;
}

export function renderScoreToSvg(score: Score, pageSpec: PageSpecInput = {}): RenderedPage[] {
  return renderLayoutToSvg(layout(score, pageSpec));
}

/** jsdom's innerHTML omits the SVG namespace, which a standalone file needs. */
function withNamespace(markup: string): string {
  if (markup.includes('xmlns=')) return markup;
  return markup.replace(/^<svg/, `<svg ${SVG_NS_ATTRIBUTE}`);
}
