# Testing

Follow the test plan in `SLICES.md` for the slice you are on; it is written per slice and it
is specific.

- **The suite is three layers** (the third, `postgres`, is V19's and opt-in — see below) (`vitest.config.ts`), split by what a test needs in order to run
  rather than by what it is about. `fast` is `unit`, `integration`, `e2e` and `arch`; `infra` is
  `store`, `api`, `cli`, `browser`, `imaging` and `eval`, and needs better-sqlite3's native binding, a
  listening socket, a real subprocess, and — for `browser` (V4d) — a real Chromium that Playwright
  drives. `imaging` and `eval` (V12) need the `@resvg/resvg-js` and `sharp` native bindings that
  `@sibei/synth/imaging` loads — which is exactly why the pure `@sibei/synth` core (generator, labels,
  metrics) is a separate subpath and stays in the fast layer.
  **The pre-push hook runs `fast` only** — a slow gate gets bypassed and then it protects nothing.
  `pnpm test` and CI run both.
- **The `fast` layer really is infra-free, and it is measured rather than intended** (KAN-514).
  A `process.dlopen` trap in the layer's `setupFiles` fails any fast-layer test that loads a
  native binding, naming the binding. Two things about it are worth knowing. It traps at **load**,
  not at import, because better-sqlite3 binds lazily — on `new Database(...)`, not on `import` —
  so the layer's property had actually been *true all along*, but true by an accident of a
  dependency's internals rather than by anything holding it. And a static import-graph guard would
  have been wrong in both directions at once: red on an import that never loaded, and silent on
  every edge it failed to resolve.
  The one test that must open a real store to prove the trap works **skips itself** when the
  binding is absent, because on that machine the load it exists to intercept cannot happen. That
  matters: without the skip, the guard would be exactly the red pre-push gate on an
  unbuilt-binding machine that KAN-514 was filed to prevent.
- **A new test directory must join a layer.** `tests/arch/suite-layers.test.ts` reads the
  config and fails if a directory belongs to neither, because the failure mode of a layered
  suite is a directory that silently never runs while the summary says green.
- **The browser E2E boots the whole stack** (`tests/browser/`, V4d): `sbscore serve` + `vite` + a
  real Chromium, with Playwright driven as a *library* under vitest so there is no seventh runner.
  It joins the **infra** layer, and CI's infra job installs the browser with
  `playwright install --with-deps chromium`. A jsdom simulation was rejected on purpose: it would
  pass while the product is broken. `playwright@1.56.0` is pinned to match the pre-installed
  Chromium build (1194).
- **The eval harness is tested without oemer, and its oemer path self-skips** (V12, `tests/eval/`).
  The harness takes an injected recogniser (`Predict`), so its plumbing and its sensitivity — a
  degraded corpus must score below a clean one — are proven with a deterministic *fake* recogniser
  that needs no worker. The one test that runs the real oemer worker end to end probes
  `SBSCORE_WORKER_URL`'s `/health` and **skips itself** when nothing answers, the same honest-report
  discipline as the dlopen skip and `tests/e2e/omr-spike.test.ts`: on a machine without oemer (or one
  where its ~7 GB is OOM-killed) the run it exists to check cannot happen, so red would be noise.
- **Every bug and every flake becomes a test first**, then gets fixed.
- **Prove a new guard by watching it fail.** A guard that has never gone red is a guard you are
  guessing about. Break the thing it protects, check the failure names the right thing, restore
  — and do it from a staged or committed tree, never against uncommitted work.
- The highest-value seam is the HTTP API, because both surfaces go through it (`PLAN.md`).
  Most behavioural tests belong there from V2 on.
- Snapshots catch unintended change. They do not judge whether the engraving looks *good* —
  only a person does that. See `proofing.md`.

## The `postgres` layer (V19)

`tests/postgres/` holds the Postgres adapter's tests. It is a third vitest project that runs **only when
`SBSCORE_TEST_DATABASE_URL` names a server**; without it the project matches no file, so a plain `pnpm test`
on a machine with no Postgres is unchanged. Reaching the tests without a database any other way is an error
in `tests/postgres/support.ts`, never a silent skip — a suite that quietly runs nothing reports green and
protects nothing.

- `pnpm test:postgres` starts a throwaway Postgres with Docker Compose (`compose.test.yaml`), runs the layer
  and removes it (`KEEP_POSTGRES=1` leaves it). Point `SBSCORE_TEST_DATABASE_URL` at your own server (as a
  superuser) to skip Docker. CI runs it as `test (postgres)` on a service container.
- **Each test gets a database of its own**, owned by an ordinary `sibei_app` role that is `NOSUPERUSER
  NOBYPASSRLS` — row-level security does not bind a superuser, so a test run as one would prove nothing about
  the backstop. The adapters themselves refuse a superuser. The databases default to an ICU `en-US`
  collation on purpose: in a `C` locale the byte-order test could never fail.
- **The store contract is asserted once** (`tests/store/conformance.ts`) and run against SQLite
  (`tests/store/conformance.test.ts`) and Postgres (`tests/postgres/conformance.test.ts`). Anything a caller
  can observe belongs there; mechanism (RLS, locks, `SKIP LOCKED`, the migration) belongs in
  `tests/postgres/postgres.test.ts`. A new adapter joins by adding one file.
- Mutation-check a new guard: break the thing it guards and watch it go red. Twice in V19 a test that
  passed first time was vacuous (a byte-order check in a `C` locale; a wrong-password test on a `trust`
  cluster).
