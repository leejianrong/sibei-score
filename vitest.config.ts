import { defineConfig } from 'vitest/config';

/**
 * Two layers, split by what a test needs in order to run rather than by what it is about.
 *
 * Until V2 the whole suite was uniformly infra-free and this file was ten lines. SQLite
 * arrives with the store, so the split arrives with it — AGENTS.md has carried this as V2's
 * due bill since V1.
 *
 *   fast   No infra, and **no native binding** — enforced, not intended: `setupFiles` traps
 *          `process.dlopen` for the whole layer, so a test that reaches a compiled module fails
 *          naming it (KAN-514). Pure logic, the engraver, the render path, the arch assertions.
 *          This is the layer the pre-push hook runs, and it has to stay quick enough that nobody
 *          is ever tempted by --no-verify: a slow gate gets bypassed, and then it protects
 *          nothing.
 *   infra  Needs a real store. Today that means better-sqlite3's native binding and a
 *          temporary database — no daemon and no container — but it is a compiled module that
 *          can fail to build on a fresh machine, and it is where V4's boots-the-whole-stack
 *          tests will land. No trap here: loading the binding is the point.
 *
 * The trap is what makes the first line of that description a fact. It arrived with the split of
 * `@sibei/api`, whose barrel used to re-export `openSqliteStore` — so importing the package for
 * the pure reducer brought the driver along, and the layer defined as needing nothing installed
 * depended on a compiled module. The adapter now lives at `@sibei/api/sqlite` and the trap says
 * so out loud if it ever comes back. `tests/arch/fast-layer-purity.test.ts` proves both halves.
 *
 * `pnpm test` runs both. `pnpm test:fast` is the gate.
 */

const FAST = [
  'tests/unit/**/*.test.ts',
  'tests/integration/**/*.test.ts',
  'tests/e2e/**/*.test.ts',
  'tests/arch/**/*.test.ts',
];

const INFRA = [
  'tests/store/**/*.test.ts',
  'tests/api/**/*.test.ts',
  'tests/cli/**/*.test.ts',
  // V4d's boots-the-whole-stack tests: `sbscore serve` + `vite` + a real Chromium, driven with
  // Playwright. They belong here, not in a seventh CI job — this layer already needs a native
  // binding and a listening socket, and this file has reserved the spot since V2a.
  'tests/browser/**/*.test.ts',
  // V12b's synthetic-imaging tests: `@sibei/synth/imaging` rasterises with @resvg/resvg-js and
  // degrades with sharp — both native bindings, so they cannot run under the fast layer's dlopen
  // trap (KAN-514). Pure synth (generator, labels, metrics) stays in the fast layer.
  'tests/imaging/**/*.test.ts',
  // V12c's eval-harness tests: they build a real corpus (rasterise + degrade, native) and, when a
  // worker is reachable, run oemer — infra, and the worker case self-skips when it is down.
  'tests/eval/**/*.test.ts',
];

/**
 * V19's Postgres tests. A third layer, and unlike the other two it is **opt-in by configuration**: it runs
 * only when `SBSCORE_TEST_DATABASE_URL` names a server (`pnpm test:postgres` provides one with Docker
 * Compose; CI provides one from a service container). Without it the project matches no file, so a plain
 * `pnpm test` on a machine with no Postgres is unchanged. Reaching the tests without a database by some
 * other route is an error in `tests/postgres/support.ts`, never a silent skip, because a suite that
 * quietly runs nothing reports green and protects nothing.
 */
const POSTGRES = ['tests/postgres/**/*.test.ts'];
const POSTGRES_DATABASE = process.env.SBSCORE_TEST_DATABASE_URL === '' ? undefined : process.env.SBSCORE_TEST_DATABASE_URL;

/** Runs before every fast-layer test file, and refuses to let one load a compiled module. */
const FAST_SETUP = ['tests/no-native-bindings.ts'];

/** Rendering the nasty chart through the whole engraver is not instant. */
const TIMEOUT = 30_000;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'fast',
          include: FAST,
          setupFiles: FAST_SETUP,
          environment: 'node',
          testTimeout: TIMEOUT,
        },
      },
      { test: { name: 'infra', include: INFRA, environment: 'node', testTimeout: TIMEOUT } },
      {
        test: {
          name: 'postgres',
          include: POSTGRES,
          // Declared always, so the layer list is honest (`tests/arch/suite-layers.test.ts` reads it), but
          // it matches no file unless a database was named — a plain `pnpm test` on a machine with no
          // Postgres must not go red. See the note above `POSTGRES`.
          exclude: POSTGRES_DATABASE === undefined ? ['**/*'] : [],
          environment: 'node',
          testTimeout: TIMEOUT,
        },
      },
    ],
  },
});
