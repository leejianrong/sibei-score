/**
 * Which rail panels are open (SIB2-264), remembered per browser. The score view's rail holds a dozen
 * document-level panels; they start collapsed except the ones used on every chart (Export, Part), and
 * a person's choice outlives a reload. Storage can be blocked, so every access is guarded and the panels
 * still work for the session without it.
 */

const KEY = 'sibei.railPanels';

function read(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function panelOpen(title: string, fallback: boolean): boolean {
  const stored = read()[title];
  return typeof stored === 'boolean' ? stored : fallback;
}

export function rememberPanel(title: string, open: boolean): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...read(), [title]: open }));
  } catch {
    // blocked storage: the choice lasts until the page does
  }
}
