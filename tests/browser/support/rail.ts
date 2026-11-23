import type { Page } from 'playwright';

/**
 * Open every collapsible rail panel (SIB2-264). The document-level panels start collapsed (a person's choice is
 * remembered per browser), so a test that drives one of their controls opens the rail first, the way a person
 * would, rather than relying on a default.
 */
export async function openRailPanels(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const panel of document.querySelectorAll<HTMLDetailsElement>('details.rail-panel')) panel.open = true;
  });
}
