import { defineConfig } from 'vitest/config';

/**
 * Two layers, split by what a test needs in order to run rather than by what it is about.
 *
 * Until V2 the whole suite was uniformly infra-free and this file was ten lines. SQLite
 * arrives with the store, so the split arrives with it — CLAUDE.md has carried this as V2's
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
];

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
    ],
  },
});
