/**
 * What a chart nobody has named is called when something has to be shown (KAN-609).
 *
 * The stored title is the empty string, not this word (KAN-594): defaulting to 'Untitled' would
 * leave nothing able to tell a chart somebody *named* "Untitled" from one nobody has named. So the
 * word lives at the display edge, and it lives here — once — because the browser and `sbscore list`
 * both show it and two surfaces phrasing the same fact separately is what this architecture exists
 * to prevent. `tests/arch/untitled-one-source.test.ts` holds the other surfaces to it.
 */
export const UNTITLED = 'Untitled';

export function displayTitle(title: string): string {
  return title === '' ? UNTITLED : title;
}
