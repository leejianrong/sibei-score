/**
 * The name of the CLI binary, in one place.
 *
 * This slice is read-only: there is no "New chart" button, because the UI's first write is V4c's
 * whole subject and splitting the first write across two cards is worse than a slice of booked
 * debt. So the library points at the terminal instead, in two places — the empty state and the
 * permanent footer — and both read this.
 *
 * The name is `sbscore`, decided and landed while this card was in flight (D67, KAN-599, the
 * ADR-0008 status note). `sibei` collided with an unrelated product of the same author,
 * `sibei-flow`, which had already settled `sb<product>` as the family convention — its console
 * script is `sbflow`, its worker package `sbflow_worker/`, its config `~/.config/sbflow/`. So the
 * repo keeps its `sibei-score` name, which was never the collision, and only the user-facing
 * binary changed.
 *
 * It stays a constant rather than two string literals for the reason the rename just demonstrated:
 * the scope rename `@sibei/*` -> `@sbscore/*` is still open (KAN-600), and one line is the whole
 * cost of being ready for it.
 *
 * The CLI's own copy of the name is not this: `packages/cli/package.json` declares the `bin` entry
 * and `commands.ts` prints it about twenty times in its usage text. So this constant *agreeing*
 * with that `bin` key is asserted, not assumed — `tests/arch/framework-free.test.ts` reads both
 * files and compares. It has to be: two cards renamed the binary in parallel, this file was not in
 * either one's diff, and the browser spent a rebase telling people to run a program that no longer
 * existed. Neither PR's tests could see it, because they lived on opposite sides of the seam.
 */
export const CLI_BINARY = 'sbscore';

/** The example the library offers when there is nothing to open. */
export const NEW_CHART_COMMAND = `${CLI_BINARY} new --title "Body and Soul" --key Db --bars 32`;

/** How to start the API when the UI cannot reach it. */
export const SERVE_COMMAND = `${CLI_BINARY} serve`;
