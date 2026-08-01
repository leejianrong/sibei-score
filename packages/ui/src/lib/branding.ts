/**
 * The name of the CLI binary, in one place.
 *
 * This slice is read-only: there is no "New chart" button, because the UI's first write is V4c's
 * whole subject and splitting the first write across two cards is worse than a slice of booked
 * debt. So the library points at the terminal instead, in two places — the empty state and the
 * permanent footer — and both read this.
 *
 * It is a constant rather than two string literals because the binary may be renamed from `sibei`
 * to `sbscore` and the decision is open. One line here, then.
 *
 * The CLI's own copy of the name is not this: `packages/cli/package.json` declares the `bin` entry
 * and `commands.ts` prints it about twenty times in its usage text. A rename is still a real
 * change over there; this only guarantees the browser is not a twenty-first place to miss.
 */
export const CLI_BINARY = 'sibei';

/** The example the library offers when there is nothing to open. */
export const NEW_CHART_COMMAND = `${CLI_BINARY} new --title "Body and Soul" --key Db --bars 32`;

/** How to start the API when the UI cannot reach it. */
export const SERVE_COMMAND = `${CLI_BINARY} serve`;
