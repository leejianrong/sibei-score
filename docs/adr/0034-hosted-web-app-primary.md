# ADR-0034: The hosted web app becomes the primary surface

- **Status:** Proposed — 2026-09-30, revised the same day after design discussion. V18 (async ports),
  V19a (tenancy keys) and V19 (the Postgres adapter) are built; the rest of SLICES v0.4 (V20–V26) is the plan.
- **Date:** 2026-09-30
- **Deciders:** Jian, in design discussion
- **Relates to:** [ADR-0001](0001-local-first-hosting-shaped.md) (which this cashes in),
  [ADR-0002](0002-server-owns-score-api-only-writer.md), [ADR-0003](0003-op-log-and-optimistic-concurrency.md),
  [ADR-0005](0005-node-owns-api-python-omr-worker.md), [ADR-0006](0006-sqlite-json-document-store.md),
  [ADR-0008](0008-imperative-cli-verbs-plus-batch.md), [ADR-0022](0022-svelte-shell-and-api-versioning.md),
  [ADR-0028](0028-score-document-schema-versioning.md), [ADR-0029](0029-local-http-threat-model.md),
  [ADR-0031](0031-bespoke-recogniser.md)

## Context

ADR-0001 built the app "hosting-shaped" and `docs/hosting.md` mapped the transition. The direction has
now been chosen: **anyone can use sibei-score in a browser**, with open sign-up. The local app stays a
supported way to run it, but the hosted web app is the primary interface, and it must be drivable by
agents — from the CLI and from a **remote MCP endpoint** — as an authenticated user.

Decisions from the design discussion: open sign-up with **GitHub login first** (Google and others
later); the only users for now are the maintainer and the agent, so launch rigour is about the *shape*,
not the scale; **import ships as beta on the bespoke engine**; deployment is **Docker Compose on a
single VM** (Hetzner or DigitalOcean) behind **Caddy** for TLS; local mode remains an option;
`sbscore auth login` authenticates against the platform; beta data may be wiped.

Reading the code against `hosting.md` found that the "swap" framing understates one thing. **The
`ScoreStore`, `JobStore` and `Authenticator` ports are synchronous** (shaped by SQLite's in-process,
synchronous driver). Every Postgres driver in Node is promise-based, because a query is a network
round-trip, so a Postgres adapter — and any session-lookup authenticator — is async-only. The first
slice is therefore a no-behaviour-change refactor of the ports, not an adapter.

## Decision

1. **Ports go async first (V18), on SQLite, with no behaviour change.** `ScoreStore`, `JobStore` and
   `Authenticator` return promises, and the applier awaits them (the store's `create` and `commit` are
   already the units of work, so there is no applier-level transaction to convert). Every existing test
   must pass unchanged in meaning. Paying this before Postgres keeps the two risks apart.
2. **Postgres is a second adapter behind the same port (V19, built)**, selected by config
   (`SBSCORE_DATABASE_URL` / `--database-url` → Postgres, otherwise SQLite — the *named* variable, not the
   generic `DATABASE_URL`, so an ambient value in an unrelated environment cannot silently move a local
   library). One shared **conformance suite** runs against both adapters. Tenancy is
   the existing `owner` column, backed by **row-level security** with the owner set per transaction
   (`SET LOCAL`). Schema versioning stays forward-on-read (ADR-0028). In production Postgres runs **in
   the Compose stack on the VM**; because it is just a database URL, a managed Postgres (Neon, etc.)
   is a config change, not a redesign. As built: documents and log payloads are stored as `text`, not
   `jsonb`, so they round-trip byte-for-byte as SQLite's do (the export cache key digests the serialised
   document); RLS is `ENABLE`d and `FORCE`d on every table with default-deny policies keyed on
   `app.owner`, plus an `app.system` branch on `import_jobs` only, for the runner; and **the adapter
   refuses to run as a superuser or `BYPASSRLS` role** (the official image's default user is one, and
   running as it would silently switch the backstop off) unless told to with `--allow-rls-bypass`.
3. **Identity is ours, GitHub is the login provider (V20).** The API implements the GitHub OAuth code
   flow directly, stores `users` (keyed by an internal id, not the GitHub login) and hashed `sessions`,
   and the browser gets an `HttpOnly`, `Secure`, `SameSite=Lax` session cookie. No passwords are ever
   stored. Providers are a small table (`provider`, `subject`) so Google etc. add rows and a route, not
   a redesign. The `owner` on every row becomes the user id. Local mode keeps `resolveLocalPrincipal`
   and owner `local`.
4. **CLI and agents authenticate with API tokens obtained by a device flow (V21).**
   `sbscore auth login` starts an RFC 8628-style device authorisation on *our* server: the CLI prints a
   short code and a URL, the user approves in the browser (already signed in via GitHub), and the CLI
   receives a token minted by us. Tokens are random, stored **hashed**, named, scoped, revocable from
   the web UI, and expire. They live in a `0600` credentials file (per base URL). `auth
   logout|status|token` round it out; `auth login --token` is the headless fallback. GitHub's own
   tokens never reach the CLI. Bearer-token requests are exempt from the cookie CSRF concern; cookie
   requests keep the Origin/Host guards.
5. **The remote MCP endpoint is first-class and lands right after tokens (V22).** A **Streamable HTTP
   MCP endpoint at `/mcp`**, same origin, is a route family on the API that goes through the same
   services and the same applier — never a second write path (ADR-0003). It is an **OAuth 2.1
   resource**: our own authorisation server (PKCE, dynamic client registration, authorisation-server
   and protected-resource metadata) reuses the GitHub session for consent and issues tokens from the V21
   token model, with an audience and scopes. Tools are built for agents: reads use the existing text
   projection (`sbscore show`), writes go through `batch` and addresses, and failures return ADR-0008's
   structured errors including `currentVersion`; export and render are tools too. `sbscore mcp` (stdio)
   is a thin local wrapper over the same client and stored credentials. The CLI remains the equivalent
   for agents that have a shell.
6. **Blobs stay on a volume at first (V23).** A single VM has a disk, and the existing directory
   `BlobStore` already works on it, so the S3-compatible adapter is deferred until there is a second
   host or a reason. The port is unchanged, so it remains a pure adapter when needed.
7. **Hosted guards widen, they do not loosen (V23).** The Host/Origin allow-list takes the real
   domain from config; bodies stay capped; add per-user and per-IP rate limits (shared counters in
   Redis) and per-user quotas (score count, stored bytes, import pages). Open sign-up makes quotas part
   of the launch, because the shape is the deliverable. Amends ADR-0029, which is local-only.
8. **Redis is in from day 1 (V23).** It carries the **cross-process change bus** (so an SSE client on
   any API process hears an edit made through another) and the **rate-limit counters**. The in-process
   bus stays the local default; the bus is a port with a Redis adapter, selected by config. Pub/sub is
   fire-and-forget, which is acceptable because a client that misses an event re-reads the current
   version. This supersedes the earlier lean towards Postgres `LISTEN/NOTIFY`.
9. **Deploy is Docker Compose on one VM, TLS by Caddy (V24).** The OCI images and a **hosted Compose
   profile** are the reference runtime: `caddy` (automatic certificates, the only published ports,
   80/443), the `api` (serving the UI, V8g), the `worker`, `postgres` and `redis` on a private network,
   volumes for Postgres and blobs. Images are built in CI and pushed to a registry; the VM pulls them.
   Secrets are an env file that is not in the repo. Backups are a nightly `pg_dump` shipped off the box
   (beta: best effort, no durability promise). The API runs as a single replica to start; Redis is what
   makes a second one a config change. Kubernetes is **not** used; nothing here precludes it later,
   because the artifact is plain images plus config.
10. **Import in the hosted app is beta and runs on the bespoke engine (V26).** The hosted deployment
    sets `SIBEI_OMR_ENGINE=bespoke` (~300 MB, ~0.6 s/page), so the worker is a small always-on
    container in the same Compose stack and oemer is not deployed. This is a **deliberate beta
    exception to ADR-0031's "swap the default only when the harness says so"**: the *local* default
    stays `oemer` until V17f. The UI must say plainly that chord recognition is unreliable (end-to-end
    chord F1 ~0.13, ADR-0031 / V17e) — notes and bars are the usable part.
11. **Retention: hard delete, no promises (V25).** Deleting an account removes its scores, op logs, jobs,
    sessions, tokens and blobs in one operation, with no soft-delete or grace period. A blob lives as
    long as the score or job that references it (reparse and the source pane need it); a sweep removes
    orphans. The UI states that this is a beta, data may be wiped, and exporting is the way to keep a
    chart. The ADR-0001 copyright posture stands: uploads are private and account-scoped, there is no
    shared library, and user uploads are never a training corpus.
12. **Local mode is preserved by config, and the primary surface is the web app.** `sbscore serve`
    (SQLite, local principal, loopback bind) is unchanged. The CLI gains a base-URL/profile so the same
    binary talks to local or hosted. The README and UI lead with the hosted app.
13. **`/v1` becomes additive-only from the first hosted deploy** (ADR-0022). New auth and MCP routes are
    additive.

## Consequences

- V18 is a wide but mechanical diff and is the riskiest early step; doing it alone, on SQLite, is the
  mitigation.
- We own session and token handling, including an OAuth authorisation server for MCP. That is more
  security-sensitive code than adopting a hosted identity product; it is the trade for keeping the
  API framework-free and the CLI/MCP flows ours. Mitigations: hashed secrets at rest, short-lived and
  single-use device codes, no passwords, tests for cross-tenant leakage, and RLS as a backstop for a
  missed `WHERE`.
- We own the VM: OS patching, disk, Docker upgrades, certificate renewal (Caddy automates the last),
  monitoring and the backup job. That is the accepted cost of the Compose choice; a single VM is also a
  single point of failure, acceptable for a beta.
- Five services on one box (caddy, api, worker, postgres, redis) is a memory budget to size: the
  worker is ~300 MB and the rest are small, so a 4 GB VM is a comfortable floor.
- Local users see no change unless they opt into `DATABASE_URL`.

## Alternatives considered

- **Fly.io + Neon.** Fastest to a public URL, with managed TLS, deploys, backups and a route to more
  machines. Rejected in favour of owning the infrastructure and keeping one portable Compose artifact;
  the images are unchanged if we move later.
- **Kubernetes.** Overkill for one API, one worker, Postgres and Redis and two users: it adds a cluster,
  ingress, cert management and upgrades without solving a problem we have. Revisit only with a reason.
- **Hosted identity product (Neon Auth, Clerk, Auth0).** Less code to own, more providers. Rejected for
  now: it puts the CLI device flow and MCP OAuth on a third party's constraints and makes local mode a
  second auth path. Revisit if provider sprawl grows.
- **Stay on SQLite (Litestream) on the VM.** Avoids V18 and V19 and is simpler for one host. Rejected
  because it keeps the store port unproven against a second engine, and Redis-backed multi-process
  is easier to reach with Postgres.
- **Postgres `LISTEN/NOTIFY` as the change bus.** One less service, but needs an unpooled connection
  for the listener and does not help rate limits. Superseded by decision 8.
- **CLI login by pasting a token from the web UI.** Kept only as the headless fallback.

## Open questions

- Which provider, Hetzner or DigitalOcean, and the VM size — a config choice, not an architectural one.
- Whether Postgres backups need a stated retention beyond "nightly, best effort".
- Rate-limit and quota numbers (set conservatively, tune with real use).
