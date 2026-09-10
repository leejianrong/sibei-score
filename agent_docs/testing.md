# Testing

Follow the test plan in `SLICES.md` for the slice you are on; it is written per slice and it
is specific.

- **The suite is two layers** (`vitest.config.ts`), split by what a test needs in order to run
  rather than by what it is about. `fast` is `unit`, `integration`, `e2e` and `arch`; `infra` is
  `store`, `api`, `cli` and `browser`, and needs better-sqlite3's native binding, a listening
  socket, a real subprocess, and — for `browser` (V4d) — a real Chromium that Playwright drives.
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
- **Every bug and every flake becomes a test first**, then gets fixed.
- **Prove a new guard by watching it fail.** A guard that has never gone red is a guard you are
  guessing about. Break the thing it protects, check the failure names the right thing, restore
  — and do it from a staged or committed tree, never against uncommitted work.
- The highest-value seam is the HTTP API, because both surfaces go through it (`PLAN.md`).
  Most behavioural tests belong there from V2 on.
- Snapshots catch unintended change. They do not judge whether the engraving looks *good* —
  only a person does that. See `proofing.md`.
