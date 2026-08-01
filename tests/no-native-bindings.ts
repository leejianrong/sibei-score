/**
 * The `fast` layer's setup file: nothing it runs may load a compiled native binding (KAN-514).
 *
 * The suite is split by *what a test needs in order to run* (`vitest.config.ts`), and the whole
 * value of `fast` is that the pre-push gate stays runnable on a machine where a native module
 * never built. That was an intention with nothing holding it up: `tests/unit/apply.test.ts` and
 * two others import `@sibei/api`, which until this change re-exported `openSqliteStore` and so
 * pulled better-sqlite3 in with it.
 *
 * It happened not to bite, and *why* is the reason this file exists rather than a comment.
 * better-sqlite3 loads its binding lazily — at `new Database(...)`, not at import — so no fast
 * test ever reached the `.node` file. The layer's defining property was true by an accident of a
 * dependency's internals, one version bump or one eager driver away from being false, and
 * nothing anywhere would have said so. So it is measured instead.
 *
 * **Where it is measured, and why there.** Every path Node has for loading a `.node` file ends at
 * `process.dlopen`. Trapping it catches the act itself rather than a proxy for it, at the moment
 * it happens, in the worker running the test. A static walk of each test file's import graph
 * would have to resolve every edge correctly to mean anything, and would pass quietly on the
 * edges it failed to follow — and it would have missed this one anyway, since the offending
 * import was real and the load was lazy.
 *
 * The refusal names the binding, because "something native loaded" is not actionable, and the
 * stack above it names the test that asked for it.
 */

/**
 * The one exemption: the test runner's own machinery, which loads inside the worker because
 * vite-node parses modules there. It is not what the layer is a claim about — vitest cannot run
 * at all without it, on either layer, so refusing it would say nothing about the code under test.
 *
 * Matched on the package the `.node` file belongs to, and the list being two entries is the
 * point: a third has to show up in a diff and be argued for, the same way the store seam's
 * allowlist does. Anything a *product* dependency loads is not on it and never will be.
 */
const THE_TEST_RUNNERS_OWN = ['@rollup/rollup-', 'fsevents'];

export const NATIVE_BINDING_REFUSED = 'ERR_SIBEI_NATIVE_BINDING';

/** The package a resolved `.node` path belongs to. Scoped names keep both segments. */
export function packageOf(filename: string): string {
  const tail = filename.replace(/\\/g, '/').split('/node_modules/').pop() ?? '';
  const [first = '', second = ''] = tail.split('/');
  return first.startsWith('@') ? `${first}/${second}` : first;
}

export function isTheTestRunnersOwn(filename: string): boolean {
  const owner = packageOf(filename);
  return THE_TEST_RUNNERS_OWN.some((prefix) => owner.startsWith(prefix));
}

interface RefusalError extends Error {
  code: string;
}

const load = process.dlopen.bind(process);

process.dlopen = (module: object, filename: string, ...rest: number[]): void => {
  if (isTheTestRunnersOwn(filename)) {
    load(module, filename, ...rest);
    return;
  }
  const error = new Error(
    `the fast suite layer must not load a native binding: ${filename}\n` +
      'A test needing one belongs in the infra layer (vitest.config.ts); an import that drags ' +
      'one in belongs behind an entry point the pure side does not reach.',
  ) as RefusalError;
  error.code = NATIVE_BINDING_REFUSED;
  throw error;
};
