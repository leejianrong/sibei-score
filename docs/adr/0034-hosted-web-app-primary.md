# ADR-0034: The hosted web app becomes the primary surface

- **Status:** Proposed — 2026-09-30. Nothing here is built; SLICES v0.4 (V18–V26) is the plan.
- **Date:** 2026-09-30
- **Deciders:** Jian, in design discussion
- **Relates to:** [ADR-0001](0001-local-first-hosting-shaped.md) (which this cashes in),
  [ADR-0002](0002-server-owns-score-api-only-writer.md), [ADR-0003](0003-op-log-and-optimistic-concurrency.md),
  [ADR-0005](0005-node-owns-api-python-omr-worker.md), [ADR-0006](0006-sqlite-json-document-store.md),
  [ADR-0008](0008-imperative-cli-verbs-plus-batch.md), [ADR-0022](0022-svelte-shell-and-api-versioning.md),
  [ADR-0028](0028-score-document-schema-versioning.md), [ADR-0029](0029-local-http-threat-model.md)

## Context

ADR-0001 built the app "hosting-shaped" and `docs/hosting.md` mapped the transition. The direction has
now been chosen: **anyone can use sibei-score in a browser**, with open sign-up. The local app stays a
supported way to run it, but the hosted web app is the primary interface, and it must be drivable from
the CLI and from an MCP server by an authenticated user.

Decisions from the design discussion: open sign-up with **GitHub login first** (Google and others
later); the only users for now are the maintainer and the agent, so launch rigour is about the *shape*,
not the scale; **import ships as beta** on the current (oemer) engine; **Fly.io + Neon Postgres**;
local mode remains an option; `sbscore auth login` authenticates against the platform.

Reading the code against `hosting.md` found that the "swap" framing understates one thing. **The
`ScoreStore`, `JobStore` and `Authenticator` ports are synchronous** (they were shaped by SQLite's
synchronous driver). A Postgres adapter, and any session-lookup authenticator, is async-only. So the
first slice is a no-behaviour-change refactor of the ports, not an adapter.

## Decision

1. **Ports go async first (V18), on SQLite, with no behaviour change.** `ScoreStore`, `JobStore` and
   `Authenticator` return promises. The op applier's transaction becomes an async unit of work. Every
   existing test must pass unchanged in meaning. This is the price of ADR-0001's seam being drawn
   around SQLite; paying it before Postgres keeps the two risks apart.
2. **Postgres is a second adapter behind the same port (V19)**, selected by config
   (`DATABASE_URL` → Postgres, otherwise SQLite). One shared **conformance suite** runs against both
   adapters, so they cannot drift. Tenancy is the existing `owner` column, backed by **row-level
   security** with the owner set per transaction (`SET LOCAL`, which is safe under Neon's pooled
   connections). Schema versioning stays forward-on-read (ADR-0028).
3. **Identity is ours, GitHub is the login provider (V20).** The API implements the GitHub OAuth code
   flow directly, stores `users` (keyed by an internal id, not the GitHub login) and hashed `sessions`
   in the store, and the browser gets an `HttpOnly`, `Secure`, `SameSite=Lax` session cookie. No
   passwords are ever stored. Providers are a small table (`provider`, `subject`) so Google etc. add
   rows and a route, not a redesign. The `owner` on every row becomes the user id. Local mode keeps
   `resolveLocalPrincipal` and owner `local`.
4. **CLI and agents authenticate with API tokens obtained by a device flow (V21).**
   `sbscore auth login` starts an RFC 8628-style device authorisation on *our* server: the CLI prints a
   short code and a URL, the user approves in the browser (already signed in via GitHub), and the CLI
   receives a token minted by us. Tokens are random, stored **hashed**, named, revocable from the web
   UI and expire. They live in a `0600` credentials file (per base URL). `auth logout|status|token`
   round it out. GitHub's own tokens never reach the CLI. Bearer-token requests are exempt from the
   cookie CSRF concern; cookie requests keep the Origin/Host guards.
5. **MCP is another thin HTTP client of `/v1`, not a second write path (V22).** First a **stdio**
   server, `sbscore mcp`, reusing the CLI's stored credentials and client. Its tools map onto the
   existing verbs and the `batch` op. Later, a **remote MCP endpoint** with OAuth 2.1 (PKCE, dynamic
   client registration, authorisation-server metadata) so hosted MCP clients can connect without the
   CLI. Both surfaces inherit ADR-0008's structured errors and ADR-0003's optimistic concurrency.
6. **Blobs go to S3-compatible storage (V23)** — Fly's Tigris is the default, as it is provisioned
   with the Fly app. The port already has an async `BlobStore`, so this is a pure adapter.
7. **Hosted guards widen, they do not loosen (V23).** The Host/Origin allow-list takes the real
   domain from config; bodies stay capped; add per-user and per-IP rate limits and per-user quotas
   (score count, stored bytes, import pages). Open sign-up makes quotas part of the launch, even with
   two users, because the shape is the deliverable. Amends ADR-0029 (which is explicitly local-only).
8. **Deploy is one Fly app + Neon (V24).** One image serves the API and the built UI (V8g). Migrations
   run as a release command. Secrets come from Fly secrets. Start with **a single machine**; SSE
   fan-out across machines is deferred (below), so do not scale out until it is solved.
9. **Cross-machine change bus: prefer Postgres `LISTEN/NOTIFY` over Redis when the time comes.** It
   removes a whole service from the hosting.md diagram. It needs a direct (unpooled) Neon connection
   for the listener. Decided when a second machine is needed, not before.
10. **Import in the hosted app is beta and flagged off by default (V26).** oemer needs ~7 GB of RAM,
    so it cannot share the API machine. It runs as a separate Fly app started on demand, reached
    across the existing `WorkerClient` port (ADR-0005), gated to an allowlist of users, no egress.
    The bespoke engine remains the intended default once V17f lands; that decision is unchanged.
11. **Local mode is preserved by config, and the primary surface is the web app.** `sbscore serve`
    (SQLite, local principal, loopback bind) is unchanged. The CLI gains a base-URL/profile so the same
    binary talks to local or hosted. The README and UI lead with the hosted app.
12. **`/v1` becomes additive-only from the first hosted deploy** (ADR-0022). New auth routes are
    additive.

## Consequences

- V18 is a wide but mechanical diff and is the riskiest early step; doing it alone, on SQLite, is the
  mitigation.
- We own session and token handling. That is more security-sensitive code than adopting a hosted
  identity product, and it is the trade for keeping the API framework-free and the CLI/MCP flows
  ours. Mitigations: hashed secrets at rest, short-lived device codes, no passwords, tests for
  cross-tenant leakage, and RLS as a backstop for a missed `WHERE`.
- The copyright posture of ADR-0001 stands: uploads are private and account-scoped, there is no shared
  library, and user uploads are never a training corpus.
- Local users see no change unless they opt into `DATABASE_URL`.

## Alternatives considered

- **Hosted identity product (Neon Auth, Clerk, Auth0).** Less code to own, and it handles more
  providers. Rejected for now: it puts the CLI device flow and MCP OAuth on a third party's
  constraints and makes local mode a second auth path. Revisit if provider sprawl grows.
- **Stay on SQLite (Litestream / LiteFS) on Fly.** Avoids V18 and V19 entirely, and is genuinely
  simpler for one machine. Rejected because Neon was chosen for managed backups, branching and a
  route to multiple machines, and because it forces the port to prove itself against a second engine.
- **CLI login by pasting a token from the web UI.** Simpler than a device flow. Kept as the fallback
  (`auth login --token`) for headless or CI use.
- **Redis change bus now.** Rejected until a second machine exists; see decision 9.

## Open questions

- Retention and deletion: account deletion must destroy the op logs and blobs (the log is the
  document). Needs a policy before public launch.
- Fly machine sizing for the beta import worker, and whether to allowlist or budget-cap it.
- Whether the remote MCP endpoint should land before or after the stdio server has real use.
